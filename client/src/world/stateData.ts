// State-scale static data (e.g. all of Indiana): manifest, tile geometry math
// and streaming of gzipped LOD tiles. Optional: if no state is built, the game
// runs with just the city region.
import {
  createProjection, tileToLonLatBounds, type MapTile, type PlaceLabel, type Projection, type StateLayerName, type StateManifest,
  type TileData,
} from '@indy/shared';

export const STATE = (import.meta.env.VITE_STATE as string | undefined) ?? 'indiana';
const base = `/world/${STATE}`;

let manifest: StateManifest | null = null;
let proj: Projection | null = null;
let loading: Promise<StateManifest | null> | null = null;
const tileSets: Partial<Record<StateLayerName, Set<string>>> = {};

export function loadStateManifest(): Promise<StateManifest | null> {
  loading ??= fetch(`${base}/manifest.json`)
    .then(async (r) => {
      if (!r.ok) return null;
      manifest = (await r.json()) as StateManifest;
      proj = createProjection(manifest.origin);
      for (const [layer, info] of Object.entries(manifest.layers)) tileSets[layer as StateLayerName] = new Set(info.tiles);
      return manifest;
    })
    .catch(() => null);
  return loading;
}

export const getStateManifest = () => manifest;

export interface TileRect { key: string; z: number; x: number; y: number; bounds: [number, number, number, number]; center: [number, number] }

/** Local-meter bounds of a slippy tile. */
export function tileRect(z: number, x: number, y: number): TileRect {
  const g = tileToLonLatBounds(x, y, z);
  const [x0, y0] = proj!.toLocal(g.south, g.west);
  const [x1, y1] = proj!.toLocal(g.north, g.east);
  return { key: `${x}-${y}`, z, x, y, bounds: [x0, y0, x1, y1], center: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

export function rectDistance(r: TileRect, x: number, yNorth: number) {
  const [x0, y0, x1, y1] = r.bounds;
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - yNorth, 0, yNorth - y1));
}

/** Existing tiles of a layer within `radius` meters of a point, nearest first. */
export function tilesNear(layer: StateLayerName, x: number, yNorth: number, radius: number): TileRect[] {
  const m = manifest, set = tileSets[layer];
  if (!m || !proj || !set) return [];
  const z = m.layers[layer].z;
  const g0 = proj.toGeo(x - radius, yNorth - radius), g1 = proj.toGeo(x + radius, yNorth + radius);
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const out: TileRect[] = [];
  for (let ix = tx(g0.lon); ix <= tx(g1.lon); ix++)
    for (let iy = ty(g1.lat); iy <= ty(g0.lat); iy++) {
      if (!set.has(`${ix}-${iy}`)) continue;
      const r = tileRect(z, ix, iy);
      if (rectDistance(r, x, yNorth) <= radius) out.push(r);
    }
  return out.sort((a, b) => rectDistance(a, x, yNorth) - rectDistance(b, x, yNorth));
}

// Small LRU of parsed tiles so panning back and forth doesn't refetch.
const cache = new Map<string, Promise<unknown>>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit as Promise<T>;
  }
  const p = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  while (cache.size > 120) cache.delete(cache.keys().next().value!);
  return p;
}

const fetchJson = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

export const loadDetailTile = (key: string) => cached(`detail/${key}`, () => fetchJson(`${base}/detail/${key}.json.gz`) as Promise<TileData>);
export const loadMapTile = (layer: 'overview' | 'mid', key: string) => cached(`${layer}/${key}`, () => fetchJson(`${base}/${layer}/${key}.json.gz`) as Promise<MapTile>);

// Places (towns/cities) from loaded map tiles, for the location label.
const places = new Map<string, PlaceLabel>();
export function registerPlaces(list: PlaceLabel[]) {
  for (const p of list) places.set(`${p.n}@${p.p[0]},${p.p[1]}`, p);
}

const RANK = { city: 0, town: 1, village: 2 } as const;
export function nearestPlace(x: number, yNorth: number): string {
  let best: { d: number; p: PlaceLabel } | null = null;
  for (const p of places.values()) {
    // Bigger places "reach" further.
    const reach = p.k === 'city' ? 12_000 : p.k === 'town' ? 5_000 : 2_000;
    const d = Math.hypot(p.p[0] - x, p.p[1] - yNorth) / reach + RANK[p.k] * 0.05;
    if (!best || d < best.d) best = { d, p };
  }
  if (!best) return manifest?.name ?? '';
  return best.d <= 1.5 ? best.p.n : `Near ${best.p.n}`;
}

export function inDetailRegion(x: number, yNorth: number) {
  const b = manifest?.detailRegion?.bbox;
  return !!b && x >= b[0] && x <= b[2] && yNorth >= b[1] && yNorth <= b[3];
}
