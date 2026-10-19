import { describe, expect, it } from 'vitest';
import {
  createProjection, lonLatToTile, tileToLonLatBounds, signedArea, polygonArea, ensureCCW, pointInPolygon, principalAngle,
  rotateRing, bounds, cleanRing, interiorPoint, hashString, createRng, seededRng,
} from '../src/index.ts';
import { lShape, rect, rotated } from './fixtures.ts';

describe('projection', () => {
  const proj = createProjection({ lat: 39.7684, lon: -86.1581 });

  it('maps the origin to (0, 0) and round-trips', () => {
    expect(proj.toLocal(39.7684, -86.1581)).toEqual([0, 0]);
    for (const [lat, lon] of [[39.775, -86.15], [39.76, -86.17], [39.7684, -86.1581]]) {
      const [x, y] = proj.toLocal(lat, lon);
      const g = proj.toGeo(x, y);
      expect(g.lat).toBeCloseTo(lat, 9);
      expect(g.lon).toBeCloseTo(lon, 9);
    }
  });

  it('uses meters with x east and y north', () => {
    const [x, y] = proj.toLocal(39.7684 + 0.001, -86.1581 + 0.001);
    expect(y).toBeCloseTo(111.3, 0); // ~111 m per 0.001° latitude
    expect(x).toBeGreaterThan(80);
    expect(x).toBeLessThan(90); // shrinks with cos(latitude)
  });

  it('computes globally unique slippy tiles', () => {
    const t = lonLatToTile(-86.1581, 39.7684, 16);
    const b = tileToLonLatBounds(t.x, t.y, 16);
    expect(-86.1581).toBeGreaterThanOrEqual(b.west);
    expect(-86.1581).toBeLessThan(b.east);
    expect(39.7684).toBeGreaterThan(b.south);
    expect(39.7684).toBeLessThanOrEqual(b.north);
  });
});

describe('polygons', () => {
  it('computes signed area and orientation', () => {
    const r = rect(0, 0, 10, 5);
    expect(signedArea(r)).toBe(50);
    expect(signedArea([...r].reverse())).toBe(-50);
    expect(signedArea(ensureCCW([...r].reverse()))).toBe(50);
    expect(polygonArea(lShape(20, 20))).toBe(300);
  });

  it('tests point containment on concave shapes', () => {
    const l = lShape(20, 20);
    expect(pointInPolygon([5, 5], l)).toBe(true);
    expect(pointInPolygon([15, 15], l)).toBe(false);
    expect(pointInPolygon([5, 5], rect(0, 0, 10, 10), [rect(2, 2, 6, 6)])).toBe(false);
  });

  it('finds the principal axis of rotated rectangles', () => {
    const fp = rotated(rect(0, 0, 40, 12), 33);
    const r = rotateRing(fp, principalAngle(fp));
    const bb = bounds(r);
    expect(bb.maxX - bb.minX).toBeCloseTo(40, 5);
    expect(bb.maxY - bb.minY).toBeCloseTo(12, 5);
  });

  it('removes duplicate and collinear points', () => {
    const ring = cleanRing([[0, 0], [5, 0], [5, 0], [10, 0], [10, 10], [0, 10]]);
    expect(ring).toHaveLength(4);
  });

  it('finds interior points even for concave shapes', () => {
    const l = lShape(30, 30);
    expect(pointInPolygon(interiorPoint(l), l)).toBe(true);
  });
});

describe('deterministic randomness', () => {
  it('hashes and seeds reproducibly', () => {
    expect(hashString('osm:w123')).toBe(hashString('osm:w123'));
    expect(hashString('osm:w123')).not.toBe(hashString('osm:w124'));
    const a = createRng(42), b = createRng(42);
    const sa = Array.from({ length: 10 }, () => a.next());
    const sb = Array.from({ length: 10 }, () => b.next());
    expect(sa).toEqual(sb);
    expect(sa.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRng('x', 1).next()).toBe(seededRng('x', 1).next());
  });
});
