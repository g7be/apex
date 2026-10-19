import type { BuildingRecord, Vec2 } from '../src/index.ts';
import { centroid, ensureCCW } from '../src/index.ts';

export function building(id: string, fp: Vec2[], tags: Record<string, string> = {}, extra: Partial<BuildingRecord> = {}): BuildingRecord {
  const ring = ensureCCW(fp);
  return { id, osm: `way/${id}`, fp: ring, tags: { building: 'yes', ...tags }, front: 0, centroid: centroid(ring), ...extra };
}

export const rect = (x0: number, y0: number, w: number, h: number): Vec2[] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];

/** L-shaped footprint: a w×h rectangle with the top-right quadrant removed. */
export const lShape = (w: number, h: number): Vec2[] => [[0, 0], [w, 0], [w, h / 2], [w / 2, h / 2], [w / 2, h], [0, h]];

export const rotated = (fp: Vec2[], deg: number): Vec2[] => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return fp.map(([x, y]) => [x * c - y * s + 100, x * s + y * c - 40]);
};
