import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {
  clearInteriorCache, deriveProfile, generateInterior, floorWalls, polygonArea, CIRCULATION_KINDS,
  type BuildingRecord, type Floor, type TileData, type Vec2, type WorldManifest,
} from '../src/index.ts';
import { building, lShape, rect, rotated } from './fixtures.ts';

const closed = (r: Vec2[]): [number, number][] => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const area = (mp: [number, number][][][]) => mp.reduce((s, poly) => s + polygonArea(poly[0].slice(0, -1) as Vec2[]) - poly.slice(1).reduce((h, r) => h + polygonArea(r.slice(0, -1) as Vec2[]), 0), 0);

const roomGeom = (r: { poly: Vec2[]; holes?: Vec2[][] }) => [closed(r.poly), ...(r.holes ?? []).map(closed)];

/** Asserts the floor is geometrically valid for the building. */
function checkFloor(b: BuildingRecord, floor: Floor) {
  const fp: [number, number][][] = [closed(b.fp), ...(b.holes ?? []).map(closed)];
  const fpArea = polygonArea(b.fp) - (b.holes ?? []).reduce((s, h) => s + polygonArea(h), 0);
  expect(floor.rooms.length).toBeGreaterThan(0);
  let total = 0;
  for (const r of floor.rooms) {
    expect(r.poly.length).toBeGreaterThanOrEqual(3);
    expect(r.area).toBeGreaterThan(0);
    total += r.area;
    // Every room lies inside the footprint.
    const outside = area(polygonClipping.difference(roomGeom(r), fp));
    expect(outside).toBeLessThan(0.02 * r.area + 0.1);
  }
  // Rooms never overlap: their total area cannot exceed the footprint.
  expect(total).toBeLessThanOrEqual(fpArea * 1.02 + 0.5);
  for (let i = 0; i < floor.rooms.length; i++)
    for (let j = i + 1; j < floor.rooms.length; j++) {
      const ov = area(polygonClipping.intersection(roomGeom(floor.rooms[i]), roomGeom(floor.rooms[j])));
      expect(ov).toBeLessThan(0.05);
    }
  return { total, fpArea };
}

/** Rooms reachable from the entrance (or stair) through doors. */
function reachable(floor: Floor) {
  const adj = new Map<string, string[]>();
  for (const d of floor.doors) {
    if (!d.rooms[1]) continue;
    adj.set(d.rooms[0], [...(adj.get(d.rooms[0]) ?? []), d.rooms[1]]);
    adj.set(d.rooms[1], [...(adj.get(d.rooms[1]) ?? []), d.rooms[0]]);
  }
  const start = floor.doors.find((d) => d.exterior)?.rooms[0] ?? floor.rooms.find((r) => r.kind === 'stair')?.id ?? floor.rooms[0].id;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const n of adj.get(queue.shift()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  return seen.size / floor.rooms.length;
}

describe('interior generation', () => {
  const cases: [string, BuildingRecord][] = [
    ['office tower', building('osm:w9001', rect(0, 0, 45, 30), { building: 'office', 'building:levels': '20' })],
    ['L-shaped apartments', building('osm:w9002', lShape(48, 40), { building: 'apartments', 'building:levels': '5' })],
    ['rotated retail', building('osm:w9003', rotated(rect(0, 0, 32, 18), 27), { building: 'retail', 'building:levels': '2' })],
    ['courtyard civic', building('osm:w9004', rect(0, 0, 70, 60), { building: 'government', 'building:levels': '4' }, { holes: [rect(20, 20, 30, 20).reverse() as Vec2[]] })],
    ['triangle', building('osm:w9005', [[0, 0], [40, 0], [10, 30]], { building: 'commercial', 'building:levels': '3' })],
    ['tiny shop', building('osm:w9006', rect(0, 0, 7, 9), { building: 'retail' })],
    ['house', building('osm:w9007', rect(0, 0, 9, 12), { building: 'house', 'building:levels': '2' })],
    ['parking garage', building('osm:w9008', rect(0, 0, 80, 40), { building: 'parking', 'building:levels': '5' })],
    ['hotel', building('osm:w9009', rect(0, 0, 60, 18), { building: 'hotel', 'building:levels': '12' })],
    ['huge stadium', building('osm:w9010', rect(0, 0, 250, 180), { building: 'stadium' })],
  ];

  for (const [name, b] of cases) {
    it(`produces valid, connected floors for: ${name}`, () => {
      const p = deriveProfile(b);
      const inter = generateInterior(b, p);
      expect(inter.floorCount).toBe(p.floors);
      for (const i of [...new Set([0, 1, p.floors - 1])].filter((i) => i < p.floors)) {
        const f = inter.getFloor(i);
        expect(f.index).toBe(i);
        const { total, fpArea } = checkFloor(b, f);
        if (!f.fallback) expect(total / fpArea).toBeGreaterThan(0.8);
        expect(reachable(f)).toBeGreaterThan(0.85);
      }
      expect(inter.getFloor(0).doors.some((d) => d.exterior)).toBe(true);
      expect(inter.roomCount).toBeGreaterThan(0);
    });
  }

  it('is deterministic across runs (stable ids and seeds)', () => {
    const b = cases[1][1];
    const first = JSON.stringify(generateInterior(b, deriveProfile(b)).getFloor(1));
    clearInteriorCache();
    const second = JSON.stringify(generateInterior(b, deriveProfile(b)).getFloor(1));
    expect(second).toBe(first);
  });

  it('generates different layouts for different buildings', () => {
    const a = building('osm:w7001', rect(0, 0, 40, 24), { building: 'office', 'building:levels': '4' });
    const c = building('osm:w7002', rect(0, 0, 40, 24), { building: 'office', 'building:levels': '4' });
    const ra = generateInterior(a, deriveProfile(a)).getFloor(1).rooms.map((r) => Math.round(r.area));
    const rc = generateInterior(c, deriveProfile(c)).getFloor(1).rooms.map((r) => Math.round(r.area));
    expect(ra).not.toEqual(rc);
  });

  it('includes circulation and the expected program', () => {
    const office = cases[0][1];
    const g = generateInterior(office, deriveProfile(office)).getFloor(0);
    const kinds = new Set(g.rooms.map((r) => r.kind));
    for (const k of ['lobby', 'corridor', 'stair', 'elevator', 'office', 'restroom'] as const) expect(kinds).toContain(k);
    const res = cases[1][1];
    const up = generateInterior(res, deriveProfile(res)).getFloor(2);
    const rkinds = new Set(up.rooms.map((r) => r.kind));
    for (const k of ['corridor', 'kitchen', 'bathroom', 'living'] as const) expect(rkinds).toContain(k);
    expect(up.rooms.find((r) => r.unit)?.name).toMatch(/^Apt 3\d\d · /);
  });

  it('numbers rooms per floor', () => {
    const office = cases[0][1];
    const inter = generateInterior(office, deriveProfile(office));
    expect(inter.getFloor(4).rooms.some((r) => /^Office 5\d\d$/.test(r.name))).toBe(true);
  });

  it('produces wall segments with door openings', () => {
    const b = cases[0][1];
    const f = generateInterior(b, deriveProfile(b)).getFloor(1);
    const walls = floorWalls(f);
    expect(walls.length).toBeGreaterThan(f.rooms.length);
    // No wall segment passes through the middle of a door.
    for (const d of f.doors) {
      for (const [a, c] of walls) {
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const ux = (c[0] - a[0]) / L, uy = (c[1] - a[1]) / L;
        const off = Math.abs((d.pos[0] - a[0]) * uy - (d.pos[1] - a[1]) * ux);
        const t = (d.pos[0] - a[0]) * ux + (d.pos[1] - a[1]) * uy;
        if (off < 0.05) expect(t < 0.1 || t > L - 0.1).toBe(true);
      }
    }
  });
});

// Runs over the real checked-in OSM dataset when present.
const worldDir = path.resolve(__dirname, '../../data/world/indianapolis-downtown');
describe.skipIf(!existsSync(path.join(worldDir, 'manifest.json')))('real downtown Indianapolis footprints', () => {
  it('generates valid ground and typical floors for every building', () => {
    const manifest = JSON.parse(readFileSync(path.join(worldDir, 'manifest.json'), 'utf8')) as WorldManifest;
    let count = 0, fallbacks = 0, rooms = 0;
    for (const t of manifest.tiles) {
      const tile = JSON.parse(readFileSync(path.join(worldDir, t.file), 'utf8')) as TileData;
      for (const b of tile.buildings) {
        const p = deriveProfile(b);
        const inter = generateInterior(b, p);
        for (const i of p.floors > 1 ? [0, 1] : [0]) {
          const f = inter.getFloor(i);
          if (f.fallback) fallbacks++;
          rooms += f.rooms.filter((r) => !CIRCULATION_KINDS.has(r.kind)).length;
          for (const r of f.rooms) {
            expect(Number.isFinite(r.area)).toBe(true);
            expect(r.poly.length).toBeGreaterThanOrEqual(3);
          }
        }
        count++;
      }
      clearInteriorCache();
    }
    expect(count).toBeGreaterThan(500);
    // The fallback is a safety net, not the norm.
    expect(fallbacks / count).toBeLessThan(0.05);
    console.log(`real data: ${count} buildings, ${rooms} rooms on sampled floors, ${fallbacks} fallback floors`);
  }, 300_000);
});
