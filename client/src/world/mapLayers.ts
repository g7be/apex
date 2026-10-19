// Statewide map layers shown when zoomed out: roads, rail, rivers, borders
// (constant-pixel-width lines), water/park polygons and town labels.
//   overview (z9): visible from orbit, projected onto the real-scale globe
//   mid (z12):     visible at regional zoom on the flat map, streamed around
//                  the view (only tiles inside the camera frustum load)
// Town labels are capped to the most important few near the view.
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { ShapeUtils, Vector2 } from 'three';
import type { LineKind, MapTile, PlaceLabel, PolyKind } from '@indy/shared';
import { getStateManifest, loadMapTile, rectDistance, registerPlaces, tilesNear, type TileRect } from './stateData.ts';
import { worldRoot } from './tileMeshes.ts';
import { flatToGlobe } from './globe.ts';
import { pointInView, rectInView } from './view.ts';

/** Camera-distance thresholds (m). */
export const MID_MIN_CAM = 4000;
export const OVERVIEW_MIN_CAM = 60_000;
/** Above this the state's roads, rivers, borders and its name are hidden: only country names show. */
export const STATE_LINES_MAX_CAM = 500_000;

const LINE_STYLE: Record<LineKind, { color: string; width: number; y: number }> = {
  // Roads are all black; importance shows through width.
  motorway: { color: '#111214', width: 3.4, y: 6 },
  trunk: { color: '#141518', width: 2.8, y: 5.5 },
  primary: { color: '#18191c', width: 2.3, y: 5 },
  secondary: { color: '#1d1e21', width: 1.7, y: 4.5 },
  tertiary: { color: '#232427', width: 1.2, y: 4 },
  rail: { color: '#7d7f86', width: 1.2, y: 3.5 },
  river: { color: '#5b93c7', width: 2.2, y: 3 },
  stream: { color: '#7fb0dc', width: 1, y: 3 },
  state_border: { color: '#0b0c0e', width: 2.6, y: 7 },
  county_border: { color: '#5c5f66', width: 1, y: 6.5 },
};
const POLY_STYLE: Record<PolyKind, { color: string; y: number }> = {
  water: { color: '#6d9fca', y: 2 },
  park: { color: '#9cc283', y: 1 },
  forest: { color: '#87b06f', y: 1 },
};

const lineMats = Object.fromEntries(
  Object.entries(LINE_STYLE).map(([k, s]) => [k, new LineMaterial({ color: s.color, linewidth: s.width, worldUnits: false })]),
) as Record<LineKind, LineMaterial>;
const polyMats = Object.fromEntries(
  Object.entries(POLY_STYLE).map(([k, s]) => [k, new THREE.MeshBasicMaterial({ color: s.color })]),
) as Record<PolyKind, THREE.MeshBasicMaterial>;

export function setLineResolution(w: number, h: number) {
  for (const m of Object.values(lineMats)) m.resolution.set(w, h);
}

// --- labels -----------------------------------------------------------------

const LABEL_PX = { city: 30, town: 24, village: 19 } as const;
function labelSprite(p: PlaceLabel): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const px = LABEL_PX[p.k] * 2;
  const font = `${p.k === 'village' ? 600 : 700} ${px}px Inter, 'Segoe UI', system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(p.n).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.6);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.22;
  ctx.strokeStyle = 'rgba(20,24,32,0.85)';
  ctx.strokeText(p.n, w / 2, c.height / 2);
  ctx.fillStyle = p.k === 'city' ? '#ffffff' : p.k === 'town' ? '#f1f4f8' : '#dfe6ee';
  ctx.fillText(p.n, w / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  // sizeAttenuation=false: scale is a fraction of the viewport height.
  const h = LABEL_PX[p.k] / 900;
  s.scale.set((h * c.width) / c.height, h, 1);
  s.renderOrder = 20;
  s.userData.place = p;
  return s;
}

// --- tiles ------------------------------------------------------------------

interface MapTileMesh {
  layer: 'overview' | 'mid';
  data: MapTile;
  rect: TileRect;
  group: THREE.Group;
  lines: THREE.Group;
  polys: THREE.Group;
  labels: THREE.Sprite[];
}

const root = new THREE.Group();
root.name = 'map-layers';
worldRoot.add(root);
const tiles = new Map<string, MapTileMesh>();
const pending = new Set<string>();

function buildTile(layer: 'overview' | 'mid', rect: TileRect, data: MapTile): MapTileMesh {
  const onGlobe = layer === 'overview';
  // Overview geometry sits on the curved Earth (absolute coords); mid tiles are
  // flat and built around their own center for precision.
  const [cx, cy] = onGlobe ? [0, 0] : rect.center;
  const v = new THREE.Vector3();
  const P = (x: number, yN: number, h: number): [number, number, number] => {
    if (!onGlobe) return [x - cx, h, -(yN - cy)];
    flatToGlobe(x, yN, h * 20, v);
    return [v.x, v.y, v.z];
  };
  const group = new THREE.Group();
  group.position.set(cx, 0, -cy);
  const lines = new THREE.Group();
  const polys = new THREE.Group();
  group.add(polys, lines);

  // Lines: one LineSegments2 per kind.
  const byKind = new Map<LineKind, number[]>();
  for (const f of data.lines) {
    const arr = byKind.get(f.k) ?? [];
    const y = LINE_STYLE[f.k].y;
    for (let i = 0; i + 3 < f.p.length; i += 2) {
      arr.push(...P(f.p[i], f.p[i + 1], y), ...P(f.p[i + 2], f.p[i + 3], y));
    }
    byKind.set(f.k, arr);
  }
  for (const [k, arr] of byKind) {
    if (!arr.length) continue;
    const g = new LineSegmentsGeometry();
    g.setPositions(arr);
    const l = new LineSegments2(g, lineMats[k]);
    l.renderOrder = 10 + LINE_STYLE[k].y;
    l.frustumCulled = !onGlobe; // three.js skips off-screen mid tiles
    lines.add(l);
  }

  // Polygons: one mesh per kind.
  const polyPos = new Map<PolyKind, number[]>();
  for (const f of data.polys) {
    const ring = (flat: number[]) => {
      const out: Vector2[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) out.push(new Vector2(flat[i] - cx, flat[i + 1] - cy));
      return out;
    };
    const outer = ring(f.p);
    if (outer.length < 3) continue;
    const holes = (f.h ?? []).map(ring).filter((h) => h.length >= 3);
    if (ShapeUtils.isClockWise(outer)) outer.reverse();
    for (const h of holes) if (!ShapeUtils.isClockWise(h)) h.reverse();
    let tris: number[][];
    try { tris = ShapeUtils.triangulateShape(outer, holes); } catch { continue; }
    const all = [...outer, ...holes.flat()];
    const arr = polyPos.get(f.k) ?? [];
    const y = POLY_STYLE[f.k].y;
    for (const t of tris) for (const i of [t[0], t[2], t[1]]) arr.push(...P(all[i].x + cx, all[i].y + cy, y));
    polyPos.set(f.k, arr);
  }
  for (const [k, arr] of polyPos) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.Mesh(g, polyMats[k]);
    m.renderOrder = 5;
    polys.add(m);
  }

  registerPlaces(data.places);
  const labels = data.places.map((p) => {
    const s = labelSprite(p);
    s.position.set(...P(p.p[0], p.p[1], 40));
    s.visible = false;
    group.add(s);
    return s;
  });
  root.add(group);
  return { layer, data, rect, group, lines, polys, labels };
}

function disposeTile(id: string, t: MapTileMesh) {
  root.remove(t.group);
  t.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  for (const s of t.labels) {
    s.material.map?.dispose();
    s.material.dispose();
  }
  tiles.delete(id);
}

function ensure(layer: 'overview' | 'mid', rect: TileRect) {
  const id = `${layer}:${rect.key}`;
  if (tiles.has(id) || pending.has(id)) return;
  pending.add(id);
  loadMapTile(layer, rect.key)
    .then((data) => {
      if (pending.has(id)) tiles.set(id, buildTile(layer, rect, data));
    })
    .catch((err) => console.warn('map tile failed', id, err))
    .finally(() => pending.delete(id));
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Max town labels on screen at once. */
const MAX_LABELS = 24;
const KIND_RANK = { city: 0, town: 1, village: 2 } as const;

function labelAllowed(p: PlaceLabel, d: number) {
  // Above ~120 km the globe's state names take over.
  if (d < 2500 || d > 120_000) return false;
  if (p.k === 'village') return d < 30_000;
  if (p.k === 'town') return d < 140_000;
  return true;
}

/**
 * Show only the most important labels near (and inside) the view instead of
 * every town in the state.
 */
function updateLabels(x: number, yNorth: number, d: number) {
  const reach = d * 2.5;
  const flatMode = d < OVERVIEW_MIN_CAM;
  const cands: { s: THREE.Sprite; p: PlaceLabel; dist: number }[] = [];
  for (const t of tiles.values()) {
    for (const s of t.labels) {
      s.visible = false;
      const p = s.userData.place as PlaceLabel;
      if (!labelAllowed(p, d)) continue;
      const dist = Math.hypot(p.p[0] - x, p.p[1] - yNorth);
      if (dist > reach) continue;
      if (flatMode && !pointInView(p.p[0], p.p[1], 40)) continue;
      cands.push({ s, p, dist });
    }
  }
  cands.sort((a, b) => KIND_RANK[a.p.k] - KIND_RANK[b.p.k] || (b.p.pop ?? 0) - (a.p.pop ?? 0) || a.dist - b.dist);
  const seen = new Set<string>();
  let shown = 0;
  for (const c of cands) {
    if (shown >= MAX_LABELS) break;
    if (seen.has(c.p.n)) continue; // same place listed in two layers
    seen.add(c.p.n);
    c.s.visible = true;
    shown++;
  }
}

/** Called a few times per second with the camera focus and distance. */
export function updateMapLayers(x: number, yNorth: number, d: number) {
  if (!getStateManifest()) return;
  // Overview: tiny, load everything once.
  for (const r of tilesNear('overview', x, yNorth, 2_000_000)) ensure('overview', r);
  // Mid: stream around the view at regional zoom.
  const radius = clamp(d * 2.2, 8000, 130_000);
  if (d < OVERVIEW_MIN_CAM * 1.2) {
    let started = 0;
    for (const r of tilesNear('mid', x, yNorth, radius)) {
      const id = `mid:${r.key}`;
      if (tiles.has(id) || pending.has(id)) continue;
      if (!rectInView(r.bounds, radius * 0.1)) continue; // only what the camera can see
      if (pending.size >= 8 || started++ >= 6) break;
      ensure('mid', r);
    }
  }
  const depthTest = d < 9000; // only buildings need real depth testing
  for (const m of [...Object.values(lineMats), ...Object.values(polyMats)]) {
    if (m.depthTest !== depthTest) { m.depthTest = depthTest; m.needsUpdate = true; }
  }
  for (const [id, t] of [...tiles]) {
    if (t.layer === 'mid' && (rectDistance(t.rect, x, yNorth) > radius * 1.5 || d > OVERVIEW_MIN_CAM * 1.6)) {
      disposeTile(id, t);
      continue;
    }
    const show = t.layer === 'overview' ? d >= OVERVIEW_MIN_CAM && d < STATE_LINES_MAX_CAM : d >= MID_MIN_CAM && d < OVERVIEW_MIN_CAM;
    t.lines.visible = t.polys.visible = show;
  }
  updateLabels(x, yNorth, d);
  for (const id of [...pending]) if (id.startsWith('mid:') && d > OVERVIEW_MIN_CAM * 1.6) pending.delete(id);
}

export const mapStats = () => ({ tiles: tiles.size, pending: pending.size });
