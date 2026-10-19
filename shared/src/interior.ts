// Procedural interiors generated from each building's real exterior footprint.
//
// These are fictional, game-generated layouts — never real floor plans.
//
// Pipeline (per building, in a "plan frame" rotated so the footprint's main
// axis is +x):
//   1. Choose a program (office, residential, retail…) from the class.
//   2. Split the depth into bands: room bands separated by corridors.
//   3. Place a stair/elevator core that fits fully inside the footprint and
//      stacks on every floor.
//   4. Cut bands into cells, add cross corridors, then clip every cell against
//      the real polygon (so L-shapes, courtyards and angled walls just work).
//   5. Merge slivers, name rooms, subdivide apartments / hotel rooms.
//   6. Connect rooms with doors (spanning tree rooted at the entrance).
// Ground and typical floors are generated once each and reused, as real
// towers repeat floor plates. Any failure falls back to a single open floor
// that is exactly the footprint, which is always inside the building.
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon } from 'polygon-clipping';
import type { Vec2 } from './geo.ts';
import type { BuildingRecord } from './types.ts';
import type { BuildingProfile, BuildingClass } from './profile.ts';
import {
  bounds, centroid, cleanRing, closestOnSegment, ensureCCW, interiorPoint, perimeter, polygonArea, principalAngle, rotatePoint, type Ring,
} from './geometry.ts';
import { createRng, hashString, type Rng } from './rng.ts';

export const INTERIOR_VERSION = 1;

export type RoomKind =
  | 'lobby' | 'reception' | 'corridor' | 'office' | 'meeting' | 'restroom' | 'storage' | 'utility' | 'stair' | 'elevator'
  | 'retail' | 'kitchen' | 'bedroom' | 'living' | 'bathroom' | 'hotel_room' | 'parking' | 'hall' | 'service' | 'break_room'
  | 'classroom' | 'dining' | 'mechanical';

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  lobby: 'Lobby', reception: 'Reception', corridor: 'Circulation', office: 'Office', meeting: 'Meeting', restroom: 'Restroom',
  storage: 'Storage', utility: 'Utility', stair: 'Stairwell', elevator: 'Elevator', retail: 'Retail', kitchen: 'Kitchen',
  bedroom: 'Bedroom', living: 'Living', bathroom: 'Bathroom', hotel_room: 'Guest Room', parking: 'Parking', hall: 'Hall',
  service: 'Service', break_room: 'Break Room', classroom: 'Classroom', dining: 'Dining', mechanical: 'Mechanical',
};

export const CIRCULATION_KINDS: ReadonlySet<RoomKind> = new Set(['corridor', 'stair', 'elevator']);

export interface Room {
  id: string;
  number?: string;
  name: string;
  kind: RoomKind;
  /** Outer ring in building-local world meters (x east, y north). */
  poly: Vec2[];
  holes?: Vec2[][];
  area: number;
  /** Apartment / suite this room belongs to. */
  unit?: string;
  /** Good label position, inside the room. */
  label: Vec2;
}

export interface Door {
  pos: Vec2;
  /** Unit vector along the wall the door sits in. */
  dir: Vec2;
  width: number;
  rooms: [string, string | null];
  exterior: boolean;
}

export interface Floor {
  index: number;
  label: string;
  elevation: number;
  height: number;
  rooms: Room[];
  doors: Door[];
  fallback: boolean;
}

export interface BuildingInterior {
  buildingId: string;
  version: number;
  /** Rotation that makes the plan axis-aligned (used by the floor-plan viewer). */
  planAngle: number;
  planCenter: Vec2;
  floorCount: number;
  /** Rooms excluding corridors/stairs, across all floors. */
  roomCount: number;
  entrance: Vec2;
  getFloor(index: number): Floor;
}

// ---------------------------------------------------------------------------
// Polygon helpers (polygon-clipping uses closed rings)

const pc = polygonClipping;
const close = (r: Vec2[]): [number, number][] => [...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]];
const open = (r: [number, number][]): Vec2[] => {
  const pts = r.map((p) => [p[0], p[1]] as Vec2);
  const a = pts[0], b = pts[pts.length - 1];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
  return pts;
};
const rectPoly = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
function polyArea(p: Polygon): number {
  return polygonArea(open(p[0])) - p.slice(1).reduce((s, h) => s + polygonArea(open(h)), 0);
}
const mpArea = (mp: MultiPolygon) => mp.reduce((s, p) => s + polyArea(p), 0);

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

interface Cell {
  poly: Polygon;
  area: number;
  kind?: RoomKind;
  name?: string;
  unit?: string;
  zone: 'rooms' | 'front' | 'back' | 'corridor' | 'core';
  band: number;
  /** Plan-frame rectangle this cell was cut from. */
  rect: [number, number, number, number];
  /** Corridor side for room bands: which y edge faces the corridor. */
  corridorEdge?: 'y0' | 'y1' | null;
  entry?: boolean;
  /** Room number, e.g. "204". */
  num?: string;
}

interface Program {
  depth: number;
  corridor: number;
  width: [number, number];
  ground: 'bands' | 'frontback' | 'grid' | 'parking';
  typical: 'bands' | 'frontback' | 'grid' | 'parking';
  core: [number, number];
}

function programFor(cls: BuildingClass, floors: number): Program {
  const core: [number, number] = floors >= 4 ? [5.6, 5.5] : [3.2, 5.5];
  switch (cls) {
    case 'office': return { depth: 6.2, corridor: 2.2, width: [3.4, 5.6], ground: 'bands', typical: 'bands', core };
    case 'residential': return { depth: 8.6, corridor: 1.8, width: [6.8, 9.8], ground: 'bands', typical: 'bands', core };
    case 'mixed': return { depth: 8.6, corridor: 1.8, width: [6.8, 9.8], ground: 'frontback', typical: 'bands', core };
    case 'hotel': return { depth: 7.2, corridor: 1.9, width: [3.8, 4.6], ground: 'bands', typical: 'bands', core };
    case 'retail': return { depth: 6.2, corridor: 2.0, width: [3.6, 5.6], ground: 'frontback', typical: 'bands', core };
    case 'civic': case 'education': return { depth: 7.4, corridor: 2.8, width: [5, 8.5], ground: 'bands', typical: 'bands', core };
    case 'religious': case 'venue': case 'landmark': case 'industrial':
      return { depth: 7, corridor: 2.4, width: [4.5, 7], ground: 'frontback', typical: 'bands', core };
    case 'parking': return { depth: 16, corridor: 0, width: [15, 18], ground: 'parking', typical: 'parking', core };
    case 'house': return { depth: 4, corridor: 1.1, width: [3, 4.6], ground: 'grid', typical: 'grid', core: [1.3, 3.4] };
    case 'structure': return { depth: 6, corridor: 0, width: [6, 10], ground: 'grid', typical: 'grid', core };
  }
}

// ---------------------------------------------------------------------------

interface Ctx {
  b: BuildingRecord;
  profile: BuildingProfile;
  fp: Polygon;
  fpRing: Ring;
  bb: ReturnType<typeof bounds>;
  W: number;
  D: number;
  area: number;
  prog: Program;
  frontPlan: Vec2;
  frontSide: 'y0' | 'y1';
  core: [number, number, number, number] | null;
  bands: { y0: number; y1: number; kind: 'rooms' | 'corridor'; corridorEdge: 'y0' | 'y1' | null }[];
  crossX: [number, number][];
  scale: number;
}

/** Shared boundary between two rings: longest collinear overlap. */
export function sharedEdge(a: Ring, b: Ring, tol = 0.06): { a: Vec2; b: Vec2; len: number } | null {
  let best: { a: Vec2; b: Vec2; len: number } | null = null;
  for (let i = 0; i < a.length; i++) {
    const p0 = a[i], p1 = a[(i + 1) % a.length];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const L = Math.hypot(dx, dy);
    if (L < 0.3) continue;
    const ux = dx / L, uy = dy / L;
    for (let j = 0; j < b.length; j++) {
      const q0 = b[j], q1 = b[(j + 1) % b.length];
      const d0 = Math.abs((q0[0] - p0[0]) * uy - (q0[1] - p0[1]) * ux);
      const d1 = Math.abs((q1[0] - p0[0]) * uy - (q1[1] - p0[1]) * ux);
      if (d0 > tol || d1 > tol) continue;
      const t0 = (q0[0] - p0[0]) * ux + (q0[1] - p0[1]) * uy;
      const t1 = (q1[0] - p0[0]) * ux + (q1[1] - p0[1]) * uy;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
      if (hi - lo > (best?.len ?? 0.05)) {
        best = { a: [p0[0] + ux * lo, p0[1] + uy * lo], b: [p0[0] + ux * hi, p0[1] + uy * hi], len: hi - lo };
      }
    }
  }
  return best;
}

function rectInside(ctx: Ctx, r: [number, number, number, number]): boolean {
  const poly = rectPoly(...r);
  const outside = safe(() => mpArea(pc.difference(poly, ctx.fp)), 1);
  return outside < 0.02;
}

function computeBands(ctx: Ctx) {
  const { bb, D, W, prog } = ctx;
  const d = prog.depth * ctx.scale, c = prog.corridor;
  const bands: Ctx['bands'] = [];
  const useCorridors = c > 0 && (prog.ground === 'bands' || prog.typical === 'bands') && W > 9;
  if (useCorridors && D >= 2 * d * 0.75 + c) {
    const k = Math.max(1, Math.round(D / (2 * d + c)));
    const unit = D / k;
    const dk = (unit - c) / 2;
    let y = bb.minY;
    for (let i = 0; i < k; i++) {
      bands.push({ y0: y, y1: y + dk, kind: 'rooms', corridorEdge: 'y1' });
      bands.push({ y0: y + dk, y1: y + dk + c, kind: 'corridor', corridorEdge: null });
      bands.push({ y0: y + dk + c, y1: y + unit, kind: 'rooms', corridorEdge: 'y0' });
      y += unit;
    }
  } else if (useCorridors && D >= d * 0.7 + c && W > 14) {
    // Single-loaded corridor along the entrance side.
    if (ctx.frontSide === 'y0') {
      bands.push({ y0: bb.minY, y1: bb.minY + c, kind: 'corridor', corridorEdge: null });
      bands.push({ y0: bb.minY + c, y1: bb.maxY, kind: 'rooms', corridorEdge: 'y0' });
    } else {
      bands.push({ y0: bb.minY, y1: bb.maxY - c, kind: 'rooms', corridorEdge: 'y1' });
      bands.push({ y0: bb.maxY - c, y1: bb.maxY, kind: 'corridor', corridorEdge: null });
    }
  } else {
    bands.push({ y0: bb.minY, y1: bb.maxY, kind: 'rooms', corridorEdge: null });
  }
  return bands;
}

function placeCore(ctx: Ctx): Ctx['core'] {
  const { profile, prog, bands, bb } = ctx;
  if (profile.floors < 2 || ctx.area < 70) return null;
  const [cw, cd0] = prog.core;
  const center = interiorPoint(ctx.fpRing);
  const candidatesY: [number, number][] = [];
  const corridors = bands.filter((b) => b.kind === 'corridor');
  corridors.sort((a, b) => Math.abs((a.y0 + a.y1) / 2 - center[1]) - Math.abs((b.y0 + b.y1) / 2 - center[1]));
  for (const cor of corridors) {
    const above = bands.find((b) => b.kind === 'rooms' && Math.abs(b.y0 - cor.y1) < 1e-6);
    const below = bands.find((b) => b.kind === 'rooms' && Math.abs(b.y1 - cor.y0) < 1e-6);
    if (above) { const cd = Math.min(cd0, above.y1 - above.y0); candidatesY.push([cor.y1, cor.y1 + cd]); }
    if (below) { const cd = Math.min(cd0, below.y1 - below.y0); candidatesY.push([cor.y0 - cd, cor.y0]); }
  }
  if (!corridors.length) {
    const cd = Math.min(cd0, (bb.maxY - bb.minY) * 0.6);
    candidatesY.push([center[1] - cd / 2, center[1] + cd / 2]);
  }
  const step = 1.5;
  for (const [y0, y1] of candidatesY) {
    for (let k = 0; k <= Math.ceil(ctx.W / step); k++) {
      for (const sgn of k === 0 ? [1] : [1, -1]) {
        const cx = center[0] + sgn * k * step;
        const r: [number, number, number, number] = [cx - cw / 2, y0, cx + cw / 2, y1];
        if (r[0] < bb.minX || r[2] > bb.maxX) continue;
        if (rectInside(ctx, r)) return r;
      }
    }
  }
  return null;
}

function computeCrossCorridors(ctx: Ctx): [number, number][] {
  const { bands, W, bb, prog } = ctx;
  const nCorr = bands.filter((b) => b.kind === 'corridor').length;
  if (!nCorr || prog.corridor === 0) return [];
  const c = prog.corridor;
  const xs: [number, number][] = [];
  if (ctx.core && (nCorr > 1 || W > 36)) xs.push([ctx.core[2], ctx.core[2] + c]);
  if (W > 60) {
    const n = Math.floor(W / 40);
    for (let i = 1; i <= n; i++) {
      const x = bb.minX + (W * i) / (n + 1);
      if (xs.every(([a, b]) => Math.abs(x - (a + b) / 2) > 15)) xs.push([x - c / 2, x + c / 2]);
    }
  }
  return xs.sort((a, b) => a[0] - b[0]);
}

function corePoly(ctx: Ctx): Polygon | null {
  return ctx.core ? rectPoly(...ctx.core) : null;
}

/** Clip a plan rectangle to the footprint, minus the core and given extra cutouts. */
function clipCell(ctx: Ctx, r: [number, number, number, number], cut: Polygon[]): MultiPolygon {
  return safe(() => {
    let mp = pc.intersection(rectPoly(...r), ctx.fp);
    const subtract = [...cut];
    const cp = corePoly(ctx);
    if (cp) subtract.push(cp);
    if (subtract.length && mp.length) mp = pc.difference(mp, ...subtract);
    return mp;
  }, []);
}

function splitWidths(x0: number, x1: number, [wMin, wMax]: [number, number], rng: Rng): number[] {
  const cuts = [x0];
  let x = x0;
  while (x1 - x > wMax) {
    const w = rng.range(wMin, wMax);
    if (x1 - (x + w) < wMin * 0.6) break;
    x += w;
    cuts.push(x);
  }
  cuts.push(x1);
  return cuts;
}

function intervalsMinus(x0: number, x1: number, cuts: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[x0, x1]];
  for (const [a, b] of cuts) {
    parts = parts.flatMap(([p, q]) => {
      if (b <= p || a >= q) return [[p, q] as [number, number]];
      const out: [number, number][] = [];
      if (a > p) out.push([p, a]);
      if (b < q) out.push([b, q]);
      return out;
    });
  }
  return parts.filter(([p, q]) => q - p > 0.5);
}

function pushPieces(cells: Cell[], mp: MultiPolygon, base: Omit<Cell, 'poly' | 'area'>) {
  for (const poly of mp) {
    const area = polyArea(poly);
    if (area > 0.05) cells.push({ ...base, poly, area });
  }
}

// --- floor layout strategies -------------------------------------------------

function layoutCorridors(ctx: Ctx): Cell[] {
  const cells: Cell[] = [];
  const { bb } = ctx;
  const rects: Polygon[] = [];
  for (const b of ctx.bands) if (b.kind === 'corridor') rects.push(rectPoly(bb.minX, b.y0, bb.maxX, b.y1));
  for (const [a, c] of ctx.crossX) rects.push(rectPoly(a, bb.minY, c, bb.maxY));
  if (!rects.length) return cells;
  const mp = safe(() => {
    const u = pc.union(rects[0], ...rects.slice(1));
    let m = pc.intersection(u, ctx.fp);
    const cp = corePoly(ctx);
    if (cp) m = pc.difference(m, cp);
    return m;
  }, [] as MultiPolygon);
  pushPieces(cells, mp, { zone: 'corridor', band: -1, rect: [bb.minX, bb.minY, bb.maxX, bb.maxY], kind: 'corridor', name: 'Corridor' });
  return cells;
}

function layoutCore(ctx: Ctx): Cell[] {
  if (!ctx.core) return [];
  const [x0, y0, x1, y1] = ctx.core;
  const cells: Cell[] = [];
  if (x1 - x0 > 4.5) {
    const sx = x0 + 3.0;
    cells.push({ poly: rectPoly(x0, y0, sx, y1), area: (sx - x0) * (y1 - y0), zone: 'core', band: -1, rect: [x0, y0, sx, y1], kind: 'stair', name: 'Stairwell' });
    const ey = Math.min(y1, y0 + 2.6);
    cells.push({ poly: rectPoly(sx, y0, x1, ey), area: (x1 - sx) * (ey - y0), zone: 'core', band: -1, rect: [sx, y0, x1, ey], kind: 'elevator', name: 'Elevator' });
    if (y1 - ey > 0.8) cells.push({ poly: rectPoly(sx, ey, x1, y1), area: (x1 - sx) * (y1 - ey), zone: 'core', band: -1, rect: [sx, ey, x1, y1], kind: 'mechanical', name: 'Shaft / Mechanical' });
  } else {
    cells.push({ poly: rectPoly(x0, y0, x1, y1), area: (x1 - x0) * (y1 - y0), zone: 'core', band: -1, rect: [x0, y0, x1, y1], kind: 'stair', name: 'Stairs' });
  }
  return cells;
}

function layoutRoomBands(ctx: Ctx, rng: Rng, width: [number, number]): Cell[] {
  const cells: Cell[] = [];
  const cross = ctx.crossX.map(([a, b]) => rectPoly(a, ctx.bb.minY, b, ctx.bb.maxY));
  ctx.bands.forEach((band, bi) => {
    if (band.kind !== 'rooms') return;
    for (const [x0, x1] of intervalsMinus(ctx.bb.minX, ctx.bb.maxX, ctx.crossX)) {
      const cuts = splitWidths(x0, x1, width, rng);
      for (let i = 0; i < cuts.length - 1; i++) {
        const r: [number, number, number, number] = [cuts[i], band.y0, cuts[i + 1], band.y1];
        pushPieces(cells, clipCell(ctx, r, cross), { zone: 'rooms', band: bi, rect: r, corridorEdge: band.corridorEdge });
      }
    }
  });
  return cells;
}

function layoutFrontBack(ctx: Ctx, rng: Rng, frontSplit: [number, number] | null): Cell[] {
  const { bb, D } = ctx;
  const cells: Cell[] = [];
  const backDepth = D < 9 ? 0 : Math.min(Math.max(3.5, D * 0.28), 9);
  const fy0 = ctx.frontSide === 'y0' ? bb.minY : bb.minY + backDepth;
  const fy1 = ctx.frontSide === 'y0' ? bb.maxY - backDepth : bb.maxY;
  const by0 = ctx.frontSide === 'y0' ? bb.maxY - backDepth : bb.minY;
  const by1 = ctx.frontSide === 'y0' ? bb.maxY : bb.minY + backDepth;
  const frontCuts = frontSplit ? splitWidths(bb.minX, bb.maxX, frontSplit, rng) : [bb.minX, bb.maxX];
  for (let i = 0; i < frontCuts.length - 1; i++) {
    const r: [number, number, number, number] = [frontCuts[i], fy0, frontCuts[i + 1], fy1];
    pushPieces(cells, clipCell(ctx, r, []), { zone: 'front', band: 0, rect: r, corridorEdge: null });
  }
  if (backDepth > 0) {
    const backCuts = splitWidths(bb.minX, bb.maxX, [4, 7.5], rng);
    for (let i = 0; i < backCuts.length - 1; i++) {
      const r: [number, number, number, number] = [backCuts[i], by0, backCuts[i + 1], by1];
      pushPieces(cells, clipCell(ctx, r, []), { zone: 'back', band: 1, rect: r, corridorEdge: null });
    }
  }
  return cells;
}

function layoutGrid(ctx: Ctx, rng: Rng): Cell[] {
  const { bb, W, D } = ctx;
  const cells: Cell[] = [];
  const rows = D > 9 ? 2 : 1;
  const cols = Math.max(1, Math.min(6, Math.round(W / rng.range(3.8, 5.2))));
  for (let r = 0; r < rows; r++) {
    const y0 = bb.minY + (D * r) / rows, y1 = bb.minY + (D * (r + 1)) / rows;
    for (let c = 0; c < cols; c++) {
      const rr: [number, number, number, number] = [bb.minX + (W * c) / cols, y0, bb.minX + (W * (c + 1)) / cols, y1];
      pushPieces(cells, clipCell(ctx, rr, []), { zone: 'rooms', band: r, rect: rr, corridorEdge: null });
    }
  }
  return cells;
}

function layoutParking(ctx: Ctx): Cell[] {
  const { bb, W } = ctx;
  const cells: Cell[] = [];
  const n = Math.max(1, Math.round(W / 16.5));
  for (let i = 0; i < n; i++) {
    const r: [number, number, number, number] = [bb.minX + (W * i) / n, bb.minY, bb.minX + (W * (i + 1)) / n, bb.maxY];
    pushPieces(cells, clipCell(ctx, r, []), { zone: 'rooms', band: 0, rect: r, corridorEdge: null });
  }
  return cells;
}

/** Merge slivers into a neighbor, or drop them if no clean merge exists. */
function mergeSlivers(cells: Cell[]): Cell[] {
  const isSliver = (c: Cell) => {
    if (c.zone === 'core' || c.zone === 'corridor') return false;
    const ring = open(c.poly[0]);
    const thickness = (2 * c.area) / Math.max(perimeter(ring), 1e-6);
    return c.area < 3.5 || thickness < 0.7;
  };
  const result = [...cells];
  for (let guard = 0; guard < 200; guard++) {
    const idx = result.findIndex(isSliver);
    if (idx < 0) break;
    const s = result[idx];
    result.splice(idx, 1);
    const ring = open(s.poly[0]);
    let best: { i: number; len: number } | null = null;
    result.forEach((c, i) => {
      if (c.zone === 'core' || c.zone === 'corridor') return;
      if (s.unit && c.unit !== s.unit) return;
      const e = sharedEdge(ring, open(c.poly[0]));
      if (e && e.len > (best?.len ?? 0.3)) best = { i, len: e.len };
    });
    if (best) {
      const target = result[(best as { i: number }).i];
      const merged = safe(() => pc.union(target.poly, s.poly), [] as MultiPolygon);
      if (merged.length === 1) result[(best as { i: number }).i] = { ...target, poly: merged[0], area: polyArea(merged[0]) };
    }
  }
  return result;
}

// --- programs (naming) -------------------------------------------------------

function distToFront(ctx: Ctx, c: Cell): number {
  const lp = interiorPoint(open(c.poly[0]));
  return Math.hypot(lp[0] - ctx.frontPlan[0], lp[1] - ctx.frontPlan[1]);
}

function distToCore(ctx: Ctx, c: Cell): number {
  const lp = centroid(open(c.poly[0]));
  if (!ctx.core) return Math.hypot(lp[0] - (ctx.bb.minX + ctx.bb.maxX) / 2, lp[1] - (ctx.bb.minY + ctx.bb.maxY) / 2);
  return Math.hypot(lp[0] - (ctx.core[0] + ctx.core[2]) / 2, lp[1] - (ctx.core[1] + ctx.core[3]) / 2);
}

/** Merge the cell closest to the entrance with its same-band neighbours into one big room. */
function makeLobby(ctx: Ctx, cells: Cell[], name: string, kind: RoomKind, targetArea: number) {
  const pool = cells.filter((c) => !c.kind && c.zone !== 'corridor');
  if (!pool.length) return;
  pool.sort((a, b) => distToFront(ctx, a) - distToFront(ctx, b));
  const seed = pool[0];
  let poly = seed.poly, area = seed.area;
  const absorbed = new Set<Cell>([seed]);
  for (let guard = 0; guard < 4 && area < targetArea; guard++) {
    const ring = open(poly[0]);
    const nb = pool.find((c) => !absorbed.has(c) && c.band === seed.band && (sharedEdge(ring, open(c.poly[0]))?.len ?? 0) > 1.5);
    if (!nb) break;
    const u = safe(() => pc.union(poly, nb.poly), [] as MultiPolygon);
    if (u.length !== 1) break;
    poly = u[0]; area = polyArea(poly); absorbed.add(nb);
  }
  for (const c of absorbed) cells.splice(cells.indexOf(c), 1);
  cells.push({ ...seed, poly, area, kind, name, entry: true });
}

function nameCell(c: Cell, kind: RoomKind, name: string) {
  c.kind = kind;
  c.name = name;
}

function pickNear(ctx: Ctx, cells: Cell[], n: number, filter: (c: Cell) => boolean, by: 'core' | 'front' = 'core'): Cell[] {
  const pool = cells.filter((c) => !c.kind && filter(c));
  pool.sort((a, b) => (by === 'core' ? distToCore(ctx, a) - distToCore(ctx, b) : distToFront(ctx, a) - distToFront(ctx, b)));
  return pool.slice(0, n);
}

function nameRemaining(cells: Cell[], kind: RoomKind, label: string, floorNo: number, startAt = 1) {
  let n = startAt;
  const pool = cells.filter((c) => !c.kind);
  pool.sort((a, b) => a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]);
  for (const c of pool) {
    const num = `${floorNo}${String(n++).padStart(2, '0')}`;
    c.kind = kind;
    c.name = `${label} ${num}`;
    c.num = num;
  }
}

/** Subdivide each residential unit cell into kitchen / bath / living / bedroom. */
function subdivideUnits(ctx: Ctx, cells: Cell[], floorNo: number, rng: Rng, hotel: boolean): Cell[] {
  const out: Cell[] = [];
  let n = 1;
  const cross = ctx.crossX.map(([a, b]) => rectPoly(a, ctx.bb.minY, b, ctx.bb.maxY));
  const pool = cells.filter((c) => !c.kind && c.zone === 'rooms');
  pool.sort((a, b) => a.band - b.band || a.rect[0] - b.rect[0]);
  for (const c of cells) if (!pool.includes(c)) out.push(c);
  for (const c of pool) {
    const unit = `${floorNo}${String(n++).padStart(2, '0')}`;
    const [x0, y0, x1, y1] = c.rect;
    const w = x1 - x0, d = y1 - y0;
    const nearAtY0 = c.corridorEdge !== 'y1';
    const nearD = Math.min(hotel ? 2.4 : 3.0, d * 0.4);
    const ny0 = nearAtY0 ? y0 : y1 - nearD, ny1 = nearAtY0 ? y0 + nearD : y1;
    const fy0 = nearAtY0 ? y0 + nearD : y0, fy1 = nearAtY0 ? y1 : y1 - nearD;
    const subs: { r: [number, number, number, number]; kind: RoomKind; name: string; entry?: boolean }[] = [];
    if (hotel || c.area < 22 || d < 5) {
      const bw = Math.min(2.4, w * 0.5);
      subs.push({ r: [x0, ny0, x0 + bw, ny1], kind: 'bathroom', name: 'Bathroom' });
      subs.push({ r: [x0 + bw, ny0, x1, ny1], kind: hotel ? 'hotel_room' : 'living', name: hotel ? 'Entry' : 'Entry', entry: true });
      subs.push({ r: [x0, fy0, x1, fy1], kind: hotel ? 'hotel_room' : 'living', name: hotel ? 'Guest Room' : 'Studio' });
    } else {
      const km = x0 + w * rng.range(0.55, 0.65);
      subs.push({ r: [x0, ny0, km, ny1], kind: 'kitchen', name: 'Kitchen', entry: true });
      subs.push({ r: [km, ny0, x1, ny1], kind: 'bathroom', name: 'Bathroom' });
      if (w >= 8.2) {
        const lm = x0 + w * rng.range(0.5, 0.6);
        subs.push({ r: [x0, fy0, lm, fy1], kind: 'living', name: 'Living Room' });
        subs.push({ r: [lm, fy0, x1, fy1], kind: 'bedroom', name: 'Bedroom' });
      } else {
        subs.push({ r: [x0, fy0, x1, fy1], kind: 'living', name: 'Living / Bedroom' });
      }
    }
    const unitCells: Cell[] = [];
    for (const s of subs) {
      const mp = safe(() => {
        const clipped = clipCell(ctx, s.r, cross);
        return clipped.length ? pc.intersection(clipped, c.poly) : [];
      }, [] as MultiPolygon);
      pushPieces(unitCells, mp, { zone: 'rooms', band: c.band, rect: s.r, corridorEdge: c.corridorEdge, kind: s.kind, name: s.name, unit, entry: s.entry });
    }
    // Hotel rooms: merge the "Entry" strip into the guest room.
    if (hotel) {
      const entry = unitCells.find((u) => u.name === 'Entry');
      const room = unitCells.find((u) => u.name === 'Guest Room');
      if (entry && room) {
        const merged = safe(() => pc.union(entry.poly, room.poly), [] as MultiPolygon);
        if (merged.length === 1) {
          unitCells.splice(unitCells.indexOf(entry), 1);
          room.poly = merged[0]; room.area = polyArea(merged[0]); room.entry = true;
        }
      }
    }
    const merged = mergeSlivers(unitCells);
    if (!merged.some((u) => u.entry) && merged.length) merged[0].entry = true;
    out.push(...merged);
  }
  return out;
}

const CLASS_ROOMS: Partial<Record<BuildingClass, { main: [RoomKind, string]; label: string }>> = {
  office: { main: ['office', 'Office'], label: 'Office' },
  civic: { main: ['office', 'Office'], label: 'Office' },
  education: { main: ['classroom', 'Classroom'], label: 'Classroom' },
  venue: { main: ['office', 'Suite'], label: 'Suite' },
  religious: { main: ['meeting', 'Classroom'], label: 'Room' },
  industrial: { main: ['office', 'Office'], label: 'Office' },
  landmark: { main: ['hall', 'Gallery'], label: 'Gallery' },
  retail: { main: ['office', 'Office'], label: 'Office' },
};

function assignOfficeLike(ctx: Ctx, cells: Cell[], floorNo: number, rng: Rng, ground: boolean) {
  const cls = ctx.profile.cls;
  const info = CLASS_ROOMS[cls] ?? CLASS_ROOMS.office!;
  if (ground) {
    makeLobby(ctx, cells, cls === 'civic' ? 'Main Lobby' : 'Lobby', 'lobby', Math.min(120, Math.max(30, ctx.area * 0.12)));
    const rec = pickNear(ctx, cells, 1, (c) => c.zone === 'rooms', 'front')[0];
    if (rec) nameCell(rec, 'reception', cls === 'civic' ? 'Security Screening' : cls === 'education' ? 'Front Office' : 'Reception');
  }
  const rest = pickNear(ctx, cells, 2, (c) => c.area >= 5 && c.area <= 40);
  rest.forEach((c, i) => nameCell(c, 'restroom', rest.length === 2 ? (i === 0 ? "Men's Restroom" : "Women's Restroom") : 'Restroom'));
  const small = cells.filter((c) => !c.kind && c.area < 8);
  small.forEach((c, i) => nameCell(c, i % 2 ? 'utility' : 'storage', i % 2 ? 'Utility Room' : 'Storage'));
  const pool = cells.filter((c) => !c.kind);
  if (pool.length >= 4) {
    const br = pool[Math.floor(rng.next() * pool.length)];
    nameCell(br, 'break_room', cls === 'education' ? 'Teachers\' Lounge' : 'Break Room');
  }
  const big = cells.filter((c) => !c.kind && c.area > 26);
  big.sort((a, b) => b.area - a.area);
  const nMeet = Math.max(big.length ? 1 : 0, Math.round(big.length * 0.4));
  big.slice(0, nMeet).forEach((c, i) => nameCell(c, 'meeting', c.area > 70 ? (cls === 'civic' ? 'Hearing Room' : 'Conference Hall') : `Meeting Room ${String.fromCharCode(65 + i)}`));
  for (const c of cells.filter((c) => !c.kind && c.area > 90)) nameCell(c, info.main[0], cls === 'education' ? 'Lecture Hall' : 'Open Office');
  nameRemaining(cells, info.main[0], info.label, floorNo);
}

function assignResidentialGround(ctx: Ctx, cells: Cell[], floorNo: number, rng: Rng): Cell[] {
  makeLobby(ctx, cells, 'Lobby', 'lobby', Math.min(80, Math.max(24, ctx.area * 0.1)));
  const amen: [RoomKind, string][] = [['service', 'Mail Room'], ['office', 'Leasing Office'], ['utility', 'Utility Room'], ['storage', 'Bike Storage'], ['service', 'Trash Room']];
  const pool = pickNear(ctx, cells, Math.min(amen.length, Math.max(1, Math.floor(cells.filter((c) => !c.kind).length / 3))), (c) => c.zone === 'rooms', 'front');
  pool.forEach((c, i) => nameCell(c, amen[i][0], amen[i][1]));
  return subdivideUnits(ctx, cells, floorNo, rng, false);
}

function assignFrontBack(ctx: Ctx, cells: Cell[], floorNo: number) {
  const cls = ctx.profile.cls;
  const t = ctx.b.tags;
  const food = ['restaurant', 'cafe', 'bar', 'pub', 'fast_food'].includes(t.amenity ?? '');
  const fronts = cells.filter((c) => c.zone === 'front' && !c.kind);
  const mainName: Record<string, [RoomKind, string]> = {
    religious: ['hall', 'Sanctuary'], venue: ['hall', 'Event Floor'], landmark: ['hall', 'Exhibit Hall'],
    industrial: ['hall', 'Warehouse Floor'], mixed: ['retail', 'Shop'], retail: ['retail', food ? 'Dining Room' : 'Shop Floor'],
  };
  const [mk, mn] = mainName[cls] ?? ['hall', 'Main Hall'];
  if (fronts.length > 1 && (cls === 'retail' || cls === 'mixed')) {
    fronts.sort((a, b) => a.rect[0] - b.rect[0]);
    fronts.forEach((c, i) => nameCell(c, 'retail', `Shop ${floorNo}${String(i + 1).padStart(2, '0')}`));
  } else {
    fronts.forEach((c, i) => nameCell(c, food ? 'dining' : mk, fronts.length > 1 ? `${mn} ${String.fromCharCode(65 + i)}` : mn));
  }
  const backNames: Record<string, [RoomKind, string][]> = {
    retail: food
      ? [['kitchen', 'Kitchen'], ['restroom', 'Restroom'], ['storage', 'Walk-in Storage'], ['office', 'Manager Office'], ['service', 'Service Area']]
      : [['storage', 'Stockroom'], ['restroom', 'Restroom'], ['office', 'Office'], ['service', 'Service Area'], ['storage', 'Storage']],
    religious: [['meeting', 'Vestry'], ['office', 'Office'], ['restroom', 'Restroom'], ['storage', 'Storage']],
    venue: [['service', 'Locker Room'], ['retail', 'Concessions'], ['restroom', 'Restrooms'], ['storage', 'Equipment Storage'], ['service', 'Service Corridor']],
    landmark: [['retail', 'Gift Shop'], ['restroom', 'Restroom'], ['office', 'Office'], ['storage', 'Archive Storage']],
    industrial: [['service', 'Loading Dock'], ['office', 'Office'], ['restroom', 'Restroom'], ['storage', 'Storage']],
  };
  const list = backNames[cls] ?? backNames.retail;
  const backs = cells.filter((c) => c.zone === 'back' && !c.kind).sort((a, b) => a.rect[0] - b.rect[0]);
  backs.forEach((c, i) => {
    const [k, n] = list[i % list.length];
    nameCell(c, k, i >= list.length ? `${n} ${Math.floor(i / list.length) + 1}` : n);
  });
  // The cell nearest the entrance is the entry room.
  const entry = [...cells].filter((c) => c.zone === 'front').sort((a, b) => distToFront(ctx, a) - distToFront(ctx, b))[0];
  if (entry) entry.entry = true;
  void floorNo;
}

function assignGrid(ctx: Ctx, cells: Cell[], ground: boolean) {
  const cls = ctx.profile.cls;
  const pool = cells.filter((c) => !c.kind).sort((a, b) => b.area - a.area);
  const house = cls === 'house' || cls === 'residential' || cls === 'mixed';
  const names: [RoomKind, string][] = house
    ? ground ? [['living', 'Living Room'], ['kitchen', 'Kitchen'], ['dining', 'Dining Room'], ['living', 'Family Room'], ['utility', 'Laundry']]
      : [['bedroom', 'Primary Bedroom'], ['bedroom', 'Bedroom 2'], ['bedroom', 'Bedroom 3'], ['living', 'Den'], ['storage', 'Closet']]
    : cls === 'retail' ? [['retail', 'Shop Floor'], ['storage', 'Storage'], ['office', 'Office'], ['service', 'Service Area']]
      : cls === 'parking' ? [['parking', 'Parking Area'], ['service', 'Pay Station']]
        : cls === 'structure' ? [['hall', 'Covered Area'], ['storage', 'Storage']]
          : [['hall', ground ? 'Main Room' : 'Upper Room'], ['office', 'Office'], ['storage', 'Storage'], ['meeting', 'Meeting Room']];
  // In a house, the room wrapped around the stairs becomes the hallway.
  const hall = house && ctx.core ? pool.find((c) => c.poly.length > 1) : undefined;
  if (hall) {
    nameCell(hall, 'corridor', ground ? 'Entry Hall' : 'Landing');
    pool.splice(pool.indexOf(hall), 1);
  }
  const smallest = pool.length >= 3 ? pool[pool.length - 1] : undefined;
  if (smallest) nameCell(smallest, house ? 'bathroom' : 'restroom', house ? 'Bathroom' : 'Restroom');
  pool.filter((c) => !c.kind).forEach((c, i) => {
    const [k, n] = names[Math.min(i, names.length - 1)];
    nameCell(c, k, i >= names.length - 1 && i > names.length - 1 ? `${n} ${i - names.length + 2}` : n);
  });
  const entry = [...cells].sort((a, b) => distToFront(ctx, a) - distToFront(ctx, b))[0];
  if (entry) entry.entry = true;
}

function assignParking(cells: Cell[], floorNo: number) {
  const pool = cells.filter((c) => !c.kind).sort((a, b) => a.rect[0] - b.rect[0]);
  pool.forEach((c, i) => {
    if (i === 0 && pool.length > 2) nameCell(c, 'service', 'Vehicle Ramp');
    else nameCell(c, 'parking', `Parking Bay ${floorNo}${String.fromCharCode(64 + i + (pool.length > 2 ? 0 : 1))}`);
  });
}

// --- doors ------------------------------------------------------------------

const HUBS: ReadonlySet<RoomKind> = new Set(['corridor', 'lobby', 'hall', 'retail', 'parking', 'dining']);

function connectRooms(rooms: Room[], fpRing: Ring, frontEdge: [Vec2, Vec2], entranceRoom: number): Door[] {
  const doors: Door[] = [];
  const n = rooms.length;
  if (!n) return doors;
  const rings = rooms.map((r) => [r.poly, ...(r.holes ?? [])]);
  const bbs = rooms.map((r) => bounds(r.poly));
  const edges: { i: number; j: number; seg: { a: Vec2; b: Vec2; len: number } }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = bbs[i], B = bbs[j];
      if (A.minX > B.maxX + 0.1 || B.minX > A.maxX + 0.1 || A.minY > B.maxY + 0.1 || B.minY > A.maxY + 0.1) continue;
      // Compare every ring: a core can sit inside another room's hole.
      let seg: ReturnType<typeof sharedEdge> = null;
      for (const ra of rings[i]) for (const rb of rings[j]) {
        const e = sharedEdge(ra, rb);
        if (e && e.len > (seg?.len ?? 0)) seg = e;
      }
      if (seg && seg.len >= 0.8) edges.push({ i, j, seg });
    }
  }
  const score = (a: Room, b: Room, len: number) => {
    let s = Math.min(len, 6) * 0.2;
    if (a.unit && a.unit === b.unit) return s + 50;
    const aHub = HUBS.has(a.kind), bHub = HUBS.has(b.kind);
    if (a.unit || b.unit) {
      const u = a.unit ? a : b, o = a.unit ? b : a;
      if (!HUBS.has(o.kind) || o.unit) return s - 40;
      return s + (u.name === 'Kitchen' || u.name === 'Entry' || u.kind === 'hotel_room' && u.name === 'Guest Room' ? 45 : -30);
    }
    if (CIRCULATION_KINDS.has(a.kind) && CIRCULATION_KINDS.has(b.kind)) s += 60;
    if (a.kind === 'corridor' || b.kind === 'corridor') s += 40;
    else if (aHub || bHub) s += 30;
    if ((a.kind === 'elevator' || b.kind === 'elevator') && !(a.kind === 'corridor' || b.kind === 'corridor' || a.kind === 'lobby' || b.kind === 'lobby')) s -= 20;
    if (a.kind === 'mechanical' || b.kind === 'mechanical') s -= 25;
    return s + 10;
  };
  const inTree = new Array(n).fill(false);
  inTree[entranceRoom] = true;
  for (let added = 1; added < n; added++) {
    let best: { e: (typeof edges)[number]; s: number } | null = null;
    for (const e of edges) {
      if (inTree[e.i] === inTree[e.j]) continue;
      const s = score(rooms[e.i], rooms[e.j], e.seg.len);
      if (!best || s > best.s) best = { e, s };
    }
    if (!best) break;
    const { i, j, seg } = best.e;
    inTree[i] = inTree[j] = true;
    const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
    const L = Math.hypot(dx, dy);
    const wide = rooms[i].kind === 'corridor' && rooms[j].kind === 'corridor' || HUBS.has(rooms[i].kind) && HUBS.has(rooms[j].kind);
    doors.push({
      pos: [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2],
      dir: [dx / L, dy / L],
      width: Math.min(L - 0.2, wide ? 1.8 : 0.95),
      rooms: [rooms[i].id, rooms[j].id],
      exterior: false,
    });
  }
  // Exterior entrance on the street-facing edge.
  const [fa, fb] = frontEdge;
  const fm: Vec2 = [(fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2];
  const er = rooms[entranceRoom];
  const ext = sharedEdge(er.poly, [fa, fb, [fm[0] + (fb[1] - fa[1]) * 1e-3, fm[1] - (fb[0] - fa[0]) * 1e-3]]) ?? exteriorSegmentNear(er.poly, fpRing, fm);
  if (ext) {
    const ex = ext.b[0] - ext.a[0], ey = ext.b[1] - ext.a[1];
    const L = Math.hypot(ex, ey);
    const t = closestOnSegment(fm, ext.a, ext.b).point;
    // Keep the door fully on the segment.
    const half = Math.min(L - 0.2, 1.8) / 2;
    const ta = Math.max(half, Math.min(L - half, Math.hypot(t[0] - ext.a[0], t[1] - ext.a[1])));
    doors.push({
      pos: [ext.a[0] + (ex / L) * ta, ext.a[1] + (ey / L) * ta],
      dir: [ex / L, ey / L],
      width: half * 2,
      rooms: [er.id, null],
      exterior: true,
    });
  }
  return doors;
}

function exteriorSegmentNear(ring: Ring, fpRing: Ring, target: Vec2) {
  let best: { a: Vec2; b: Vec2; len: number; d: number } | null = null;
  for (let i = 0; i < fpRing.length; i++) {
    const e = sharedEdge(ring, [fpRing[i], fpRing[(i + 1) % fpRing.length], fpRing[(i + 2) % fpRing.length]]);
    if (!e || e.len < 1) continue;
    const d = closestOnSegment(target, e.a, e.b).dist;
    if (!best || d < best.d) best = { ...e, d };
  }
  return best;
}

// --- main -------------------------------------------------------------------

function fallbackFloor(b: BuildingRecord, profile: BuildingProfile, index: number, fpRing: Ring, frontEdge: [Vec2, Vec2]): Floor {
  const kind: RoomKind = profile.cls === 'parking' ? 'parking' : profile.cls === 'retail' ? 'retail' : profile.cls === 'office' ? 'office' : 'hall';
  const room: Room = {
    id: `${b.id}/f${index}/r0`,
    number: `${index + 1}01`,
    name: index === 0 ? 'Open Floor' : `Open Floor ${index + 1}`,
    kind,
    poly: fpRing,
    holes: b.holes,
    area: Math.round(polygonArea(fpRing) * 10) / 10,
    label: interiorPoint(fpRing, b.holes),
  };
  return {
    index,
    label: floorLabel(index),
    elevation: profile.minHeight + index * profile.floorHeight,
    height: profile.floorHeight,
    rooms: [room],
    doors: index === 0 ? connectRooms([room], fpRing, frontEdge, 0) : [],
    fallback: true,
  };
}

const floorLabel = (i: number) => (i === 0 ? 'Floor 1 (Ground)' : `Floor ${i + 1}`);

const interiorCache = new Map<string, BuildingInterior>();

export function generateInterior(b: BuildingRecord, profile: BuildingProfile): BuildingInterior {
  const key = `${b.id}:${INTERIOR_VERSION}`;
  const hit = interiorCache.get(key);
  if (hit) return hit;
  const fpRing = ensureCCW(cleanRing(b.fp));
  const fi = Math.min(b.front, b.fp.length - 1);
  const frontEdge: [Vec2, Vec2] = [b.fp[fi], b.fp[(fi + 1) % b.fp.length]];
  const seed = hashString(`${b.id}:interior:v${INTERIOR_VERSION}`);
  const angle = principalAngle(fpRing);
  const c = centroid(fpRing);
  const toPlan = (p: Vec2) => rotatePoint(p, angle, c);
  const fromPlan = (p: Vec2) => rotatePoint(p, -angle, c);

  const planRing = fpRing.map(toPlan);
  const planHoles = (b.holes ?? []).map((h) => ensureCCW(h).reverse().map(toPlan));
  const bb = bounds(planRing);
  const area = polygonArea(planRing) - planHoles.reduce((s, h) => s + polygonArea(h), 0);
  const prog = programFor(profile.cls, profile.floors);
  const fm = toPlan([(frontEdge[0][0] + frontEdge[1][0]) / 2, (frontEdge[0][1] + frontEdge[1][1]) / 2]);

  const W = bb.maxX - bb.minX, D = bb.maxY - bb.minY;
  // Keep cell counts sane for huge footprints by scaling the room grid.
  const estCells = (D / Math.max(prog.depth, 1)) * (W / ((prog.width[0] + prog.width[1]) / 2));
  const scale = estCells > 140 ? Math.sqrt(estCells / 140) : 1;
  const ctx: Ctx = {
    b, profile, fpRing: planRing,
    fp: [close(planRing), ...planHoles.map(close)],
    bb, W, D, area, prog: { ...prog, width: [prog.width[0] * scale, prog.width[1] * scale] },
    frontPlan: fm,
    frontSide: fm[1] < (bb.minY + bb.maxY) / 2 ? 'y0' : 'y1',
    core: null, bands: [], crossX: [], scale,
  };
  ctx.bands = computeBands(ctx);
  ctx.core = safe(() => placeCore(ctx), null);
  ctx.crossX = computeCrossCorridors(ctx);

  const variants = new Map<string, Floor | null>();
  const small = area < 90 || D < 6 || W < 6;

  function buildFloor(index: number): Floor {
    const ground = index === 0;
    const floorNo = index + 1;
    const rng = createRng(seed ^ Math.imul(index + 1, 0x9e3779b1));
    const strategy = small ? 'grid' : ground ? prog.ground : prog.typical;
    let cells: Cell[] = [];
    cells.push(...layoutCore(ctx));
    if (strategy === 'bands') {
      cells.push(...layoutCorridors(ctx));
      cells.push(...layoutRoomBands(ctx, rng, ctx.prog.width));
    } else if (strategy === 'frontback') {
      const split: [number, number] | null = (profile.cls === 'retail' || profile.cls === 'mixed') && W > 26 ? [9 * scale, 16 * scale] : null;
      cells.push(...layoutFrontBack(ctx, rng, split));
    } else if (strategy === 'parking') {
      cells.push(...layoutParking(ctx));
    } else {
      cells.push(...layoutGrid(ctx, rng));
    }
    cells = mergeSlivers(cells);

    const cls = profile.cls;
    if (strategy === 'bands') {
      if (cls === 'residential' || cls === 'mixed') cells = ground ? assignResidentialGround(ctx, cells, floorNo, rng) : subdivideUnits(ctx, cells, floorNo, rng, false);
      else if (cls === 'hotel') {
        if (ground) {
          makeLobby(ctx, cells, 'Hotel Lobby', 'lobby', Math.min(150, Math.max(40, area * 0.15)));
          const extras: [RoomKind, string][] = [['reception', 'Front Desk'], ['dining', 'Restaurant'], ['office', 'Back Office'], ['storage', 'Luggage Storage']];
          pickNear(ctx, cells, extras.length, (x) => x.zone === 'rooms', 'front').forEach((x, i) => nameCell(x, extras[i][0], extras[i][1]));
          const rr = pickNear(ctx, cells, 2, (x) => x.area <= 40);
          rr.forEach((x, i) => nameCell(x, 'restroom', i ? "Women's Restroom" : "Men's Restroom"));
          // A few meeting rooms near the lobby; the rest of the floor is guest rooms.
          pickNear(ctx, cells, 3, (x) => x.zone === 'rooms' && x.area >= 20, 'front')
            .forEach((x, i) => nameCell(x, 'meeting', `Meeting Room ${String.fromCharCode(65 + i)}`));
          cells = subdivideUnits(ctx, cells, floorNo, rng, true);
        } else {
          const hk = pickNear(ctx, cells, 1, (x) => x.zone === 'rooms')[0];
          if (hk) nameCell(hk, 'utility', 'Housekeeping');
          cells = subdivideUnits(ctx, cells, floorNo, rng, true);
        }
      } else assignOfficeLike(ctx, cells, floorNo, rng, ground);
    } else if (strategy === 'frontback') assignFrontBack(ctx, cells, floorNo);
    else if (strategy === 'parking') assignParking(cells, floorNo);
    else assignGrid(ctx, cells, ground);
    for (const cell of cells) {
      if (!cell.kind) nameCell(cell, 'storage', 'Storage');
      cell.name ??= ROOM_KIND_LABELS[cell.kind!];
    }

    // Convert to world frame rooms.
    const rooms: Room[] = cells.map((cell, i) => {
      const outer = ensureCCW(open(cell.poly[0]).map(fromPlan));
      const holes = cell.poly.slice(1).map((h) => open(h).map(fromPlan));
      const num = cell.num;
      return {
        id: `${b.id}/f${index}/r${i}`,
        number: cell.unit ?? num,
        name: cell.unit ? `${profile.cls === 'hotel' ? 'Room' : 'Apt'} ${cell.unit} · ${cell.name}` : cell.name!,
        kind: cell.kind!,
        poly: outer,
        holes: holes.length ? holes : undefined,
        area: Math.round(polyArea(cell.poly) * 10) / 10,
        unit: cell.unit,
        label: interiorPoint(outer, holes),
      };
    });
    // Entrance room: ground floors connect from the street, upper floors from the stair.
    let root = 0;
    if (ground) {
      const fmw = fromPlan(fm);
      const entryCells = cells.map((cl, i) => ({ cl, i })).filter(({ cl }) => cl.entry && !cl.unit);
      const cands = entryCells.length ? entryCells : cells.map((cl, i) => ({ cl, i }));
      let bestD = Infinity;
      for (const { i } of cands) {
        const d = Math.min(...rooms[i].poly.map((p, k, arr) => closestOnSegment(fmw, p, arr[(k + 1) % arr.length]).dist));
        if (d < bestD) { bestD = d; root = i; }
      }
    } else {
      const st = rooms.findIndex((r) => r.kind === 'stair');
      root = st >= 0 ? st : rooms.findIndex((r) => r.kind === 'corridor');
      if (root < 0) root = 0;
    }
    const doors = connectRooms(rooms, fpRing, frontEdge, root).filter((d) => ground || !d.exterior);
    return {
      index,
      label: floorLabel(index),
      elevation: profile.minHeight + index * profile.floorHeight,
      height: profile.floorHeight,
      rooms,
      doors,
      fallback: false,
    };
  }

  function validate(floor: Floor): boolean {
    if (!floor.rooms.length) return false;
    const fpGeom: Polygon = [close(fpRing), ...(b.holes ?? []).map(close)];
    let total = 0;
    for (const r of floor.rooms) {
      if (!Number.isFinite(r.area) || r.poly.length < 3) return false;
      total += r.area;
      const outside = safe(() => mpArea(pc.difference([close(r.poly)], fpGeom)), Infinity);
      if (outside > 0.02 * r.area + 0.1) return false;
    }
    const fpArea = polygonArea(fpRing) - (b.holes ?? []).reduce((s, h) => s + polygonArea(h), 0);
    return total <= fpArea * 1.02 + 0.5;
  }

  const variantKey = (i: number) => (i === 0 ? 'ground' : 'typical');

  function getFloor(index: number): Floor {
    const i = Math.max(0, Math.min(profile.floors - 1, index));
    const vk = variantKey(i);
    let template = variants.get(vk);
    if (template === undefined) {
      const f = safe(() => buildFloor(i === 0 ? 0 : 1), null);
      template = f && validate(f) ? f : null;
      variants.set(vk, template);
    }
    if (!template) return fallbackFloor(b, profile, i, fpRing, frontEdge);
    if (template.index === i) return template;
    // Re-number a typical floor template for floor i.
    const from = String(template.index + 1), to = String(i + 1);
    const renum = (s?: string) => (s && s.startsWith(from) ? to + s.slice(from.length) : s);
    return {
      ...template,
      index: i,
      label: floorLabel(i),
      elevation: profile.minHeight + i * profile.floorHeight,
      rooms: template.rooms.map((r) => ({
        ...r,
        id: r.id.replace(`/f${template!.index}/`, `/f${i}/`),
        number: renum(r.number),
        unit: renum(r.unit),
        name: r.name.replace(new RegExp(`\\b${from}(\\d{2}|[A-Z])\\b`, 'g'), `${to}$1`),
      })),
      doors: template.doors.map((d) => ({
        ...d,
        rooms: [d.rooms[0].replace(`/f${template!.index}/`, `/f${i}/`), d.rooms[1]?.replace(`/f${template!.index}/`, `/f${i}/`) ?? null],
      })),
    };
  }

  const countRooms = (f: Floor) => f.rooms.filter((r) => !CIRCULATION_KINDS.has(r.kind)).length;
  const g = getFloor(0);
  const roomCount = countRooms(g) + (profile.floors > 1 ? countRooms(getFloor(1)) * (profile.floors - 1) : 0);
  const ext = g.doors.find((d) => d.exterior);

  const interior: BuildingInterior = {
    buildingId: b.id,
    version: INTERIOR_VERSION,
    planAngle: angle,
    planCenter: c,
    floorCount: profile.floors,
    roomCount,
    entrance: ext?.pos ?? [(frontEdge[0][0] + frontEdge[1][0]) / 2, (frontEdge[0][1] + frontEdge[1][1]) / 2],
    getFloor,
  };
  if (interiorCache.size > 200) interiorCache.delete(interiorCache.keys().next().value!);
  interiorCache.set(key, interior);
  return interior;
}

export function clearInteriorCache() {
  interiorCache.clear();
}

/** Wall segments for a floor with door openings removed (used by 3D interiors and collision). */
export function floorWalls(floor: Floor): [Vec2, Vec2][] {
  const segs: [Vec2, Vec2][] = [];
  const seen = new Set<string>();
  const k = (p: Vec2) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;
  for (const room of floor.rooms) {
    for (const ring of [room.poly, ...(room.holes ?? [])]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const id = [k(a), k(b)].sort().join('|');
        if (seen.has(id)) continue;
        seen.add(id);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.05) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        // Collect door gaps on this edge.
        const gaps: [number, number][] = [];
        for (const d of floor.doors) {
          const off = Math.abs((d.pos[0] - a[0]) * uy - (d.pos[1] - a[1]) * ux);
          if (off > 0.08) continue;
          const t = (d.pos[0] - a[0]) * ux + (d.pos[1] - a[1]) * uy;
          if (t < -0.01 || t > L + 0.01) continue;
          gaps.push([t - d.width / 2, t + d.width / 2]);
        }
        gaps.sort((p, q) => p[0] - q[0]);
        let t0 = 0;
        for (const [g0, g1] of gaps) {
          if (g0 > t0 + 0.05) segs.push([[a[0] + ux * t0, a[1] + uy * t0], [a[0] + ux * g0, a[1] + uy * g0]]);
          t0 = Math.max(t0, g1);
        }
        if (L > t0 + 0.05) segs.push([[a[0] + ux * t0, a[1] + uy * t0], b]);
      }
    }
  }
  return segs;
}
