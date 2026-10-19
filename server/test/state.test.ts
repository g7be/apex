// Statewide buildings: the server finds them through a tile hint, prices them
// from its own data, and remembers where leases are.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { centroid, deriveProfile, ensureCCW, type BuildingRecord, type StateManifest, type TileData, type Vec2, type WorldManifest } from '@indy/shared';
import { loadCatalog } from '../src/catalog.ts';
import { startServer, type RunningServer } from '../src/app.ts';
import { TestClient, tempDir, testConfig } from './helpers.ts';

const origin = { lat: 39.7684, lon: -86.1581 };
const rect = (x: number, y: number, w: number, h: number): Vec2[] => ensureCCW([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const bld = (id: string, fp: Vec2[], tags: Record<string, string>): BuildingRecord => ({ id, osm: `way/${id.slice(5)}`, fp, tags, front: 0, centroid: centroid(fp), name: `Test ${id}` });

function writeWorld(dir: string) {
  // City region with one building.
  const city = path.join(dir, 'city');
  mkdirSync(path.join(city, 'tiles'), { recursive: true });
  const cityTile: TileData = { key: '16-1-1', buildings: [bld('osm:w1', rect(0, 0, 20, 20), { building: 'office' })], roads: [], areas: [], trees: [] };
  writeFileSync(path.join(city, 'tiles/16-1-1.json'), JSON.stringify(cityTile));
  const cm = { region: 'city', name: 'City', origin, tileZoom: 16, bounds: [-1000, -1000, 1000, 1000], tiles: [{ key: '16-1-1', z: 16, x: 1, y: 1, bounds: [0, 0, 1, 1], buildings: 1, file: 'tiles/16-1-1.json' }], neighborhoods: [], landmarks: [], spawn: [0, 0], stats: {} } as unknown as WorldManifest;
  writeFileSync(path.join(city, 'manifest.json'), JSON.stringify(cm));
  // State with one far-away detail tile.
  const state = path.join(dir, 'state');
  mkdirSync(path.join(state, 'detail'), { recursive: true });
  const far: TileData = { key: '14-4253-6251', buildings: [bld('osm:w777', rect(-32000, -67000, 15, 12), { building: 'retail' })], roads: [], areas: [], trees: [] };
  writeFileSync(path.join(state, 'detail/4253-6251.json.gz'), gzipSync(JSON.stringify(far)));
  const sm: StateManifest = {
    region: 'state', name: 'State', origin, bounds: [-200_000, -200_000, 200_000, 200_000], attribution: '', source: { file: '', importedAt: '', dataset: '' },
    detailRegion: null, layers: { overview: { z: 9, tiles: [] }, mid: { z: 12, tiles: [] }, detail: { z: 14, tiles: ['4253-6251'] } },
    stats: { buildings: 1, lines: 0, polygons: 0, places: 0 },
  };
  writeFileSync(path.join(state, 'manifest.json'), JSON.stringify(sm));
}

describe('statewide catalog', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
    writeWorld(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it('finds state buildings only through a valid tile hint', () => {
    const cat = loadCatalog(tmp.dir, 'city', 'state');
    expect(cat.get('osm:w1')?.tile).toBe('city/16-1-1');
    expect(cat.get('osm:w777')).toBeUndefined();
    expect(cat.get('osm:w777', 'state/detail/4253-6251')?.profile.monthlyRent).toBe(deriveProfile(bld('osm:w777', rect(-32000, -67000, 15, 12), { building: 'retail' })).monthlyRent);
    // Wrong tile, unknown tile, other region and path tricks are all rejected.
    expect(cat.get('osm:w777', 'state/detail/4253-6252')).toBeUndefined();
    expect(cat.get('osm:w777', 'other/detail/4253-6251')).toBeUndefined();
    expect(cat.get('osm:w777', 'state/detail/../../city/manifest')).toBeUndefined();
    expect(cat.bounds).toEqual([-200_000, -200_000, 200_000, 200_000]);
  });

  describe('over WebSockets', () => {
    let server: RunningServer;
    const clients: TestClient[] = [];
    beforeEach(async () => {
      server = await startServer(testConfig(tmp.db, { worldDir: tmp.dir, region: 'city', stateRegion: 'state' }));
    });
    afterEach(async () => {
      for (const c of clients.splice(0)) c.close();
      await server.close();
    });

    it('rents a statewide building and records where it is', async () => {
      const a = new TestClient(server.port);
      clients.push(a);
      await a.hello(undefined, 'Alice');
      a.send({ t: 'rent', req: 1, buildingId: 'osm:w777', tile: 'state/detail/4253-6251' });
      const res = await a.wait('result', (m) => m.req === 1);
      expect(res.ok).toBe(true);
      expect(res.lease?.buildingName).toBe('Test osm:w777');
      expect(res.lease?.tile).toBe('state/detail/4253-6251');
      expect(res.lease?.center?.[0]).toBeCloseTo(-31992.5, 1);
      expect(res.lease?.center?.[1]).toBeCloseTo(-66994, 1);
      // Renewing works without a hint: the lease remembers its tile.
      a.send({ t: 'renew', req: 2, buildingId: 'osm:w777' });
      expect((await a.wait('result', (m) => m.req === 2)).ok).toBe(true);
      // Without a hint an unknown statewide id is rejected.
      a.send({ t: 'rent', req: 3, buildingId: 'osm:w999' });
      expect((await a.wait('result', (m) => m.req === 3)).ok).toBe(false);
      // Positions far from the city are accepted (state bounds).
      a.send({ t: 'state', p: [-32000, 0, -67000], ry: 0, anim: 'idle', in: null });
    });
  });
});
