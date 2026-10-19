// Imperative tile mesh management (outside React for performance):
// lazy creation by distance, level of detail, disposal of far tiles, picking
// via per-building triangle ranges, and in-place roof tinting for leases.
//
// Two building sources:
//   city  – full-detail region tiles (windows, doors, rooftop units, trees)
//   state – statewide "lite" tiles (simplified footprints, plain walls)
// State tiles are built relative to their own center (group offset) so
// vertex precision stays good hundreds of kilometers from the origin.
import * as THREE from 'three';
import type { Lease, TileData } from '@indy/shared';
import { materials, toGeometry } from './materials.ts';
import { buildTileMesh, jobStats } from './meshJobs.ts';
import { getManifest, indexBuildings, loadTile, tileDistance, tilesByDistance, unindexBuildings } from './worldData.ts';
import { STATE, getStateManifest, loadDetailTile, rectDistance, tilesNear, type TileRect } from './stateData.ts';
import type { BuildingRange } from './geometryBuilder.ts';
import { hexToRgb } from './geometryBuilder.ts';
import { game } from '../state/store.ts';
import { rectInView } from './view.ts';

interface TileMesh {
  id: string;
  source: 'city' | 'state';
  rect?: TileRect;
  data?: TileData;
  group: THREE.Group;
  walls: THREE.Mesh;
  roofs: THREE.Mesh;
  details: THREE.Mesh;
  trees: THREE.Object3D;
  ranges: BuildingRange[];
  wallStarts: number[];
  roofStarts: number[];
  roofBaseColors: Float32Array;
  tinted: Set<string>;
}

/** Camera distances (m) above which each building source is hidden. */
export const CITY_MAX_CAM = 9000;
export const STATE_MAX_CAM = 5500;

export const worldRoot = new THREE.Group();
worldRoot.name = 'world';
const meshes = new Map<string, TileMesh>();
const building = new Set<string>();
let hidden = false;
let leaseState: { leases: Record<string, Lease>; me: string | null } = { leases: {}, me: null };

const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.6, 6).translate(0, 1.3, 0);
const crownGeos = [
  new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4.2, 0),
  new THREE.DodecahedronGeometry(2.1, 0).translate(0, 4.0, 0),
  new THREE.ConeGeometry(2.0, 5.0, 7).translate(0, 4.8, 0),
];

function makeTrees(data: Float32Array): THREE.Object3D {
  const group = new THREE.Group();
  const n = data.length / 4;
  if (!n) return group;
  const trunks = new THREE.InstancedMesh(trunkGeo, materials.trunk, n);
  const byVariant: number[][] = [[], [], []];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const x = data[i * 4], y = data[i * 4 + 1], s = data[i * 4 + 2], v = data[i * 4 + 3];
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (x * 13.7 + y * 7.1) % 6.28);
    m.compose(new THREE.Vector3(x, 0, -y), q, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    byVariant[v % 3].push(i);
  }
  trunks.castShadow = true;
  group.add(trunks);
  byVariant.forEach((idx, v) => {
    if (!idx.length) return;
    const crowns = new THREE.InstancedMesh(crownGeos[v], materials.crown[v], idx.length);
    idx.forEach((i, k) => {
      trunks.getMatrixAt(i, m);
      crowns.setMatrixAt(k, m);
    });
    crowns.castShadow = true;
    group.add(crowns);
  });
  return group;
}

async function createTile(id: string, source: TileMesh['source'], load: () => Promise<TileData>, rect?: TileRect) {
  if (meshes.has(id) || building.has(id)) return;
  building.add(id);
  try {
    const data = await load();
    if (source === 'state') indexBuildings(data.buildings, `${STATE}/detail/${rect!.key}`);
    const origin: [number, number] = rect ? rect.center : [0, 0];
    const lite = source === 'state';
    const res = await buildTileMesh(data, { lite, origin });
    if (!building.has(id)) return; // disposed while building
    const group = new THREE.Group();
    group.name = `tile:${id}`;
    group.position.set(origin[0], 0, -origin[1]);
    const walls = new THREE.Mesh(toGeometry(res.buildings.walls), lite ? materials.wallLite : materials.facade);
    const roofs = new THREE.Mesh(toGeometry(res.buildings.roofs), materials.roof);
    const details = new THREE.Mesh(toGeometry(res.buildings.details), materials.detail);
    const ground = new THREE.Mesh(toGeometry(res.ground.ground), materials.ground);
    for (const m of [walls, roofs, details]) { m.castShadow = true; m.receiveShadow = true; }
    ground.receiveShadow = true;
    walls.userData.pick = roofs.userData.pick = id;
    const trees = makeTrees(res.ground.trees);
    group.add(ground, walls, roofs, details, trees);
    const ranges = res.buildings.ranges;
    const tm: TileMesh = {
      id, source, rect, data: source === 'state' ? data : undefined, group, walls, roofs, details, trees, ranges,
      wallStarts: ranges.map((r) => r.wall[0]),
      roofStarts: ranges.map((r) => r.roof[0]),
      roofBaseColors: (roofs.geometry.getAttribute('color').array as Float32Array).slice(),
      tinted: new Set(),
    };
    if (hidden) walls.visible = roofs.visible = details.visible = trees.visible = false;
    meshes.set(id, tm);
    worldRoot.add(group);
    applyTints(tm);
    if (source === 'state') game.set((st) => ({ dataVersion: st.dataVersion + 1 }));
  } catch (err) {
    console.warn('tile mesh failed', id, err);
  } finally {
    building.delete(id);
  }
}

function disposeTile(tm: TileMesh) {
  worldRoot.remove(tm.group);
  tm.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const mesh = o as THREE.Mesh;
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
      else mesh.geometry.dispose();
    }
  });
  meshes.delete(tm.id);
  if (tm.data) {
    // Keep index entries the UI may still need (selection, leases).
    const st = game.get();
    unindexBuildings(tm.data.buildings, (id) => id === st.selectedId || !!st.leases[id]);
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Called a few times per second with the camera focus (region-local x, north) and camera distance. */
export function updateStreaming(x: number, yNorth: number, camDist: number) {
  // City: full detail near the region.
  const manifest = getManifest();
  if (manifest) {
    const radius = clamp(camDist * 1.6, 900, 3500);
    if (camDist < CITY_MAX_CAM) {
      for (const info of tilesByDistance(x, yNorth)) {
        if (tileDistance(info, x, yNorth) > radius) break;
        const id = `city:${info.key}`;
        if (!meshes.has(id) && rectInView(info.bounds, 150)) void createTile(id, 'city', () => loadTile(info.key));
      }
    }
    for (const tm of [...meshes.values()]) {
      if (tm.source !== 'city') continue;
      const info = manifest.tiles.find((t) => `city:${t.key}` === tm.id)!;
      const d = tileDistance(info, x, yNorth);
      if (d > radius + 600 || camDist > CITY_MAX_CAM * 1.3) { disposeTile(tm); continue; }
      const show = !hidden && camDist < CITY_MAX_CAM;
      tm.walls.visible = tm.roofs.visible = show;
      tm.details.visible = show && d < 380 && camDist < 1500;
      tm.trees.visible = show && d < 700 && camDist < 2500;
    }
  }
  // State: simplified buildings everywhere else, only when zoomed in.
  if (getStateManifest()) {
    const radius = clamp(camDist * 1.5, 1500, 5000);
    if (camDist < STATE_MAX_CAM) {
      let started = 0;
      for (const r of tilesNear('detail', x, yNorth, radius)) {
        const id = `state:${r.key}`;
        if (meshes.has(id) || building.has(id)) continue;
        if (!rectInView(r.bounds, 200)) continue; // only what the camera can see
        if (building.size >= 8 || started++ >= 4) break; // avoid flooding the workers
        void createTile(id, 'state', () => loadDetailTile(r.key), r);
      }
    }
    for (const tm of [...meshes.values()]) {
      if (tm.source !== 'state') continue;
      const d = rectDistance(tm.rect!, x, yNorth);
      if (d > radius + 1500 || camDist > STATE_MAX_CAM * 1.4) { disposeTile(tm); continue; }
      tm.walls.visible = tm.roofs.visible = !hidden && camDist < STATE_MAX_CAM;
    }
  }
}

export const meshStats = () => ({ tiles: meshes.size, city: [...meshes.values()].filter((m) => m.source === 'city').length, building: building.size });

// --- picking ---------------------------------------------------------------

function rangeIndex(starts: number[], vertex: number) {
  let lo = 0, hi = starts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= vertex) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function pickBuilding(raycaster: THREE.Raycaster): { id: string; point: THREE.Vector3; distance: number } | null {
  const targets: THREE.Object3D[] = [];
  for (const tm of meshes.values()) targets.push(tm.walls, tm.roofs);
  const hits = raycaster.intersectObjects(targets, false);
  for (const h of hits) {
    const tm = meshes.get(h.object.userData.pick as string);
    if (!tm || h.faceIndex == null) continue;
    const isWall = h.object === tm.walls;
    const vertex = h.faceIndex * 3;
    const i = rangeIndex(isWall ? tm.wallStarts : tm.roofStarts, vertex);
    if (i < 0) continue;
    const r = tm.ranges[i];
    const [s, c] = isWall ? r.wall : r.roof;
    if (vertex >= s && vertex < s + c) return { id: r.id, point: h.point, distance: h.distance };
  }
  return null;
}

/** Ground point under the cursor (y = 0 plane). */
export function pickGround(raycaster: THREE.Raycaster): THREE.Vector3 | null {
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p);
}

// --- lease tints -------------------------------------------------------------

const MINE = hexToRgb('#3ddc84');

function cssToRgb(css: string): [number, number, number] {
  const c = new THREE.Color(css);
  return [c.r, c.g, c.b];
}

function applyTints(tm: TileMesh) {
  const attr = tm.roofs.geometry.getAttribute('color') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  let changed = false;
  for (const r of tm.ranges) {
    const lease = leaseState.leases[r.id];
    const want = lease ? (lease.playerId === leaseState.me ? MINE : cssToRgb(lease.playerColor)) : null;
    if (!want && !tm.tinted.has(r.id)) continue;
    const [s, c] = r.roof;
    for (let v = s; v < s + c; v++) {
      for (let k = 0; k < 3; k++) {
        const base = tm.roofBaseColors[v * 3 + k];
        arr[v * 3 + k] = want ? base * 0.35 + want[k] * 0.65 : base;
      }
    }
    if (want) tm.tinted.add(r.id);
    else tm.tinted.delete(r.id);
    changed = true;
  }
  if (changed) attr.needsUpdate = true;
}

export function setLeaseTints(leases: Record<string, Lease>, me: string | null) {
  leaseState = { leases, me };
  for (const tm of meshes.values()) applyTints(tm);
}

/** Hide buildings (not the ground) while the player is inside an interior. */
export function setWorldVisible(v: boolean) {
  hidden = !v;
  for (const tm of meshes.values()) {
    tm.walls.visible = tm.roofs.visible = v;
    if (!v) tm.details.visible = tm.trees.visible = false;
  }
}

// Debug hook for browser devtools / automated smoke tests.
Object.assign(((globalThis as { __indy?: object }).__indy ??= {}), { meshStats, worldRoot, jobStats, updateStreaming, pickBuilding, meshes });
