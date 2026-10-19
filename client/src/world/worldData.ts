// Static world data on the client: manifest, tile streaming, building index,
// collision grid and street lookup. Static geography is fetched as cacheable
// JSON tiles; player-modified state comes only from the game server.
import {
  closestOnSegment, deriveProfile, pointInPolygon, type BuildingProfile, type BuildingRecord, type TileData, type TileInfo, type Vec2,
  type WorldManifest,
} from '@indy/shared';
import { game } from '../state/store.ts';

export const REGION = (import.meta.env.VITE_REGION as string | undefined) ?? 'indianapolis-downtown';
const base = `/world/${REGION}`;

export interface IndexedBuilding {
  record: BuildingRecord;
  profile: BuildingProfile;
  /** Source-qualified tile ref, e.g. "indianapolis-downtown/16-17083-24867" or "indiana/detail/4270-6216". */
  tile: string;
}

interface Collider {
  id: string;
  ring: Vec2[];
  holes?: Vec2[][];
}

const CELL = 40;
const tiles = new Map<string, { info: TileInfo; data?: TileData; loading?: Promise<TileData> }>();
const index = new Map<string, IndexedBuilding>();
const colliderGrid = new Map<string, Collider[]>();
const streetGrid = new Map<string, { a: Vec2; b: Vec2; name: string }[]>();
const listeners = new Set<(tile: TileData) => void>();
let manifest: WorldManifest | null = null;
let manifestLoad: Promise<WorldManifest> | null = null;

const cellKey = (x: number, y: number) => `${x},${y}`;
function addToGrid<T>(grid: Map<string, T[]>, minX: number, minY: number, maxX: number, maxY: number, item: T) {
  for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++)
    for (let y = Math.floor(minY / CELL); y <= Math.floor(maxY / CELL); y++) {
      const k = cellKey(x, y);
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(item);
    }
}

export function loadManifest(): Promise<WorldManifest> {
  manifestLoad ??= fetchManifest().catch((err) => {
    manifestLoad = null;
    throw err;
  });
  return manifestLoad;
}

async function fetchManifest(): Promise<WorldManifest> {
  const res = await fetch(`${base}/manifest.json`);
  if (!res.ok) throw new Error(`Could not load world manifest (${res.status}). Is the server running and the world built?`);
  manifest = (await res.json()) as WorldManifest;
  for (const t of manifest.tiles) tiles.set(t.key, { info: t });
  game.set({ manifest, loading: { tilesLoaded: 0, tilesTotal: manifest.tiles.length, ready: false } });
  return manifest;
}

export const getManifest = () => manifest;
export const getBuilding = (id: string) => index.get(id);
export const allBuildings = () => index.values();
export const tileData = (key: string) => tiles.get(key)?.data;
export const onTileData = (fn: (tile: TileData) => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** Add buildings from any source (city tiles or streamed state tiles) to the index. */
export function indexBuildings(buildings: BuildingRecord[], tileRef: string) {
  for (const b of buildings) index.set(b.id, { record: b, profile: deriveProfile(b), tile: tileRef });
}

export function unindexBuildings(buildings: BuildingRecord[], keep: (id: string) => boolean) {
  for (const b of buildings) if (!keep(b.id)) index.delete(b.id);
}

function ingest(data: TileData) {
  for (const b of data.buildings) {
    const profile = deriveProfile(b);
    index.set(b.id, { record: b, profile, tile: `${REGION}/${data.key}` });
    if (!profile.solid || profile.minHeight > 2.5) continue;
    const xs = b.fp.map((p) => p[0]), ys = b.fp.map((p) => p[1]);
    addToGrid(colliderGrid, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), { id: b.id, ring: b.fp, holes: b.holes });
  }
  for (const r of data.roads) {
    if (!r.name || ['footway', 'cycleway', 'steps', 'rail'].includes(r.kind)) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      addToGrid(streetGrid, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), { a, b, name: r.name });
    }
  }
}

export function loadTile(key: string): Promise<TileData> {
  const t = tiles.get(key);
  if (!t) return Promise.reject(new Error(`unknown tile ${key}`));
  if (t.data) return Promise.resolve(t.data);
  if (t.loading) return t.loading;
  t.loading = fetch(`${base}/${t.info.file}`)
    .then((r) => {
      if (!r.ok) throw new Error(`tile ${key}: HTTP ${r.status}`);
      return r.json() as Promise<TileData>;
    })
    .then((data) => {
      t.data = data;
      ingest(data);
      const s = game.get();
      game.set({ dataVersion: s.dataVersion + 1, loading: { ...s.loading, tilesLoaded: s.loading.tilesLoaded + 1 } });
      for (const fn of listeners) fn(data);
      return data;
    })
    .catch((err) => {
      t.loading = undefined;
      throw err;
    });
  return t.loading;
}

export function tileDistance(info: TileInfo, x: number, yNorth: number) {
  const [x0, y0, x1, y1] = info.bounds;
  const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - yNorth, 0, yNorth - y1);
  return Math.hypot(dx, dy);
}

export function tilesByDistance(x: number, yNorth: number): TileInfo[] {
  return [...tiles.values()].map((t) => t.info).sort((a, b) => tileDistance(a, x, yNorth) - tileDistance(b, x, yNorth));
}

/** Load tile data near a point first, then everything else in the background (data only). */
export async function streamData(x: number, yNorth: number, nearRadius = 700) {
  const ordered = tilesByDistance(x, yNorth);
  const near = ordered.filter((t) => tileDistance(t, x, yNorth) <= nearRadius);
  await Promise.all(near.map((t) => loadTile(t.key).catch((e) => console.warn(e))));
  game.set((s) => ({ loading: { ...s.loading, ready: true } }));
  for (const t of ordered) {
    if (!tiles.get(t.key)?.data) await loadTile(t.key).catch((e) => console.warn(e));
  }
}

// --- queries ----------------------------------------------------------------

export function collidersNear(x: number, yNorth: number, r: number): Collider[] {
  const out = new Set<Collider>();
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
    for (let cy = Math.floor((yNorth - r) / CELL); cy <= Math.floor((yNorth + r) / CELL); cy++)
      for (const c of colliderGrid.get(cellKey(cx, cy)) ?? []) out.add(c);
  return [...out];
}

export function buildingAt(x: number, yNorth: number): string | null {
  for (const c of collidersNear(x, yNorth, 0)) if (pointInPolygon([x, yNorth], c.ring, c.holes)) return c.id;
  return null;
}

/** Nearest building edge within `maxDist` meters. */
export function nearestBuilding(x: number, yNorth: number, maxDist: number): { id: string; dist: number } | null {
  let best: { id: string; dist: number } | null = null;
  for (const c of collidersNear(x, yNorth, maxDist)) {
    for (let i = 0; i < c.ring.length; i++) {
      const d = closestOnSegment([x, yNorth], c.ring[i], c.ring[(i + 1) % c.ring.length]).dist;
      if (d <= maxDist && (!best || d < best.dist)) best = { id: c.id, dist: d };
    }
  }
  return best;
}

export function streetAt(x: number, yNorth: number, maxDist = 30): string {
  let best = { d: Infinity, name: '' };
  for (let cx = Math.floor((x - maxDist) / CELL); cx <= Math.floor((x + maxDist) / CELL); cx++)
    for (let cy = Math.floor((yNorth - maxDist) / CELL); cy <= Math.floor((yNorth + maxDist) / CELL); cy++)
      for (const s of streetGrid.get(cellKey(cx, cy)) ?? []) {
        const d = closestOnSegment([x, yNorth], s.a, s.b).dist;
        if (d < best.d && d <= maxDist) best = { d, name: s.name };
      }
  return best.name;
}

export function neighborhoodAt(x: number, yNorth: number): string {
  if (Math.hypot(x, yNorth) < 120) return 'Monument Circle';
  const m = manifest;
  if (!m) return '';
  let best = { d: Infinity, name: m.name.split(',')[0] };
  for (const n of m.neighborhoods) {
    const d = Math.hypot(n.pos[0] - x, n.pos[1] - yNorth);
    if (d < best.d && d < 1100) best = { d, name: n.name };
  }
  return best.name;
}
