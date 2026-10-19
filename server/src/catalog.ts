// Read-only building catalog backed by the static world tiles. The server uses
// it to look up authoritative prices and rentability; clients never supply them.
//
// - The city region (a few thousand buildings) is indexed at startup.
// - Statewide buildings (millions) are not: a lookup names the tile the
//   building lives in ("indiana/detail/4270-6216"), and the server loads that
//   tile from its own static data (LRU-cached). The client's tile hint only
//   says where to look; price and rentability still come from server data,
//   and a building that isn't in that tile simply isn't found.
// A world-scale deployment would back the same interface with PostGIS or a
// tile cache keyed by the same global tile ids.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { deriveProfile, type BuildingProfile, type BuildingRecord, type StateManifest, type TileData, type WorldManifest } from '@indy/shared';

export interface CatalogEntry {
  record: BuildingRecord;
  profile: BuildingProfile;
  /** Source-qualified tile ref. */
  tile: string;
}

export interface BuildingCatalog {
  region: string;
  manifest: WorldManifest;
  /** Local-meter bounds players may roam (state bounds when a state is loaded). */
  bounds: [number, number, number, number];
  get(id: string, tileRef?: string): CatalogEntry | undefined;
  size: number;
}

const TILE_REF = /^([a-z0-9-]{1,64})\/detail\/(\d{1,7}-\d{1,7})$/;

export function loadCatalog(worldDir: string, region: string, stateRegion?: string): BuildingCatalog {
  const dir = path.join(worldDir, region);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`World data not found at ${manifestFile}. Run "npm run data:build" (see README).`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as WorldManifest;
  const index = new Map<string, CatalogEntry>();
  for (const t of manifest.tiles) {
    const tile = JSON.parse(readFileSync(path.join(dir, t.file), 'utf8')) as TileData;
    for (const record of tile.buildings) index.set(record.id, { record, profile: deriveProfile(record), tile: `${region}/${t.key}` });
  }

  let bounds = manifest.bounds;
  let stateTiles: Set<string> | null = null;
  const stateDir = stateRegion ? path.join(worldDir, stateRegion) : null;
  if (stateDir && existsSync(path.join(stateDir, 'manifest.json'))) {
    const sm = JSON.parse(readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as StateManifest;
    if (sm.origin.lat !== manifest.origin.lat || sm.origin.lon !== manifest.origin.lon) {
      throw new Error(`State ${stateRegion} and region ${region} must share one origin.`);
    }
    stateTiles = new Set(sm.layers.detail.tiles);
    bounds = sm.bounds;
  }

  const lru = new Map<string, Map<string, CatalogEntry>>();
  function stateTile(key: string): Map<string, CatalogEntry> | undefined {
    if (!stateDir || !stateTiles?.has(key)) return undefined;
    const hit = lru.get(key);
    if (hit) {
      lru.delete(key);
      lru.set(key, hit);
      return hit;
    }
    const tile = JSON.parse(gunzipSync(readFileSync(path.join(stateDir, 'detail', `${key}.json.gz`))).toString('utf8')) as TileData;
    const m = new Map<string, CatalogEntry>();
    for (const record of tile.buildings) m.set(record.id, { record, profile: deriveProfile(record), tile: `${stateRegion}/detail/${key}` });
    lru.set(key, m);
    while (lru.size > 64) lru.delete(lru.keys().next().value!);
    return m;
  }

  return {
    region,
    manifest,
    bounds,
    size: index.size,
    get(id, tileRef) {
      const hit = index.get(id);
      if (hit) return hit;
      const m = tileRef?.match(TILE_REF);
      if (!m || m[1] !== stateRegion) return undefined;
      return stateTile(m[2])?.get(id);
    },
  };
}
