// Procedural building / street geometry, produced as plain typed arrays so it
// can run inside a Web Worker. Everything is derived deterministically from
// the static tile data plus the building's seeded profile.
//
// Coordinates: tile data is (x east, y north) meters; three.js uses
// (x, height, -y). All buildings in a tile are merged into a handful of
// buffers (one draw call per material) with per-building vertex ranges so
// picking and recoloring individual buildings stays possible.
import { ShapeUtils, Vector2 } from 'three';
import {
  centroid, closestOnSegment, createRng, deriveProfile, ensureCCW, ensureCW, interiorPoint, pointInPolygon, polygonArea,
  principalAngle, rotatePoint, bounds, type BuildingPart, type BuildingProfile, type BuildingRecord, type FacadeStyle, type RoofShape,
  type TileData, type Vec2, hashString, parseColour,
} from '@indy/shared';

export const STYLE_INDEX: Record<FacadeStyle, number> = {
  glass: 0, concrete: 1, brick: 2, limestone: 3, residential: 4, industrial: 5, parking: 6, historic: 7,
};

class Buf {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  /** Facade-only attributes. */
  grid: number[] = [];
  facade: number[] = [];
  seed: number[] = [];
  constructor(public facadeAttrs = false) {}
  get count() { return this.pos.length / 3; }
  vert(x: number, y: number, z: number, n: [number, number, number], c: [number, number, number], g?: [number, number], f?: [number, number, number, number], s = 0) {
    this.pos.push(x, y, z);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    if (this.facadeAttrs) {
      this.grid.push(g?.[0] ?? -1, g?.[1] ?? -1);
      this.facade.push(...(f ?? [0, 0, 0, 0]));
      this.seed.push(s);
    }
  }
  /**
   * Flat triangle with a computed normal (three.js space). When `away` is given
   * the winding is flipped as needed so the face points away from that point.
   */
  tri(a: number[], b: number[], c: number[], col: [number, number, number], away?: number[]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (away) {
      const mx = (a[0] + b[0] + c[0]) / 3 - away[0], my = (a[1] + b[1] + c[1]) / 3 - away[1], mz = (a[2] + b[2] + c[2]) / 3 - away[2];
      if (mx * nx + my * ny + mz * nz < 0) {
        for (const p of [a, c, b]) this.vert(p[0], p[1], p[2], [-nx, -ny, -nz], col);
        return;
      }
    }
    for (const p of [a, b, c]) this.vert(p[0], p[1], p[2], [nx, ny, nz], col);
  }
  out() {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      color: new Float32Array(this.col),
      ...(this.facadeAttrs ? { grid: new Float32Array(this.grid), facade: new Float32Array(this.facade), seed: new Float32Array(this.seed) } : {}),
    };
  }
}
export type BufOut = ReturnType<Buf['out']>;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  // Convert sRGB to linear for vertex colors.
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}
const shade = (c: [number, number, number], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------------------
// Walls

interface WallOpts {
  base: number;
  top: number;
  color: [number, number, number];
  style: number;
  windowRatio: number;
  floors: number;
  floorHeight: number;
  storefront: boolean;
  seed: number;
  /** Grid row of the base, so windows of raised parts line up with floors. */
  rowOffset: number;
  bay: number;
}

function addWalls(buf: Buf, ring: Vec2[], o: WallOpts, inner = false) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 0.01) continue;
    let nx = dy / L, nz = dx / L; // outward normal (dy, -dx) mapped to three (x, -y)
    // three: normal = (n2x, 0, -n2y) with n2 = (dy, -dx)/L -> (dy/L, 0, dx/L)
    if (inner) { nx = -nx; nz = -nz; }
    const bays = L < 1.4 ? 0 : Math.max(1, Math.round(L / o.bay));
    const wr = bays === 0 ? 0 : o.windowRatio;
    const g0 = o.rowOffset, g1 = o.rowOffset + (o.top - o.base) / o.floorHeight;
    const f: [number, number, number, number] = [o.style, wr, o.floors, o.storefront ? 1 : 0];
    const A0 = [a[0], o.base, -a[1]], B0 = [b[0], o.base, -b[1]], B1 = [b[0], o.top, -b[1]], A1 = [a[0], o.top, -a[1]];
    const nrm: [number, number, number] = [nx, 0, nz];
    const quad = inner ? [A0, A1, B1, A0, B1, B0] : [A0, B0, B1, A0, B1, A1];
    const gu = inner ? [0, 0, bays, 0, bays, bays] : [0, bays, bays, 0, bays, 0];
    const gv = inner ? [g0, g1, g1, g0, g1, g0] : [g0, g0, g1, g0, g1, g1];
    for (let k = 0; k < 6; k++) buf.vert(quad[k][0], quad[k][1], quad[k][2], nrm, o.color, [gu[k], gv[k]], inner ? [o.style, 0, 0, 0] : f, o.seed);
  }
}

// ---------------------------------------------------------------------------
// Roofs

function triangulate(outer: Vec2[], holes: Vec2[][] = []): number[][] {
  const contour = ensureCCW(outer).map((p) => new Vector2(p[0], p[1]));
  const hs = holes.map((h) => ensureCW(h).map((p) => new Vector2(p[0], p[1])));
  const tris = ShapeUtils.triangulateShape(contour, hs);
  const all = [...contour, ...hs.flat()];
  return tris.map((t) => t.map((i) => [all[i].x, all[i].y]).flat());
}

function addFlat(buf: Buf, outer: Vec2[], holes: Vec2[][] | undefined, y: number, color: [number, number, number], down = false) {
  for (const t of triangulate(outer, holes)) {
    const a = [t[0], y, -t[1]], b = [t[2], y, -t[3]], c = [t[4], y, -t[5]];
    buf.tri(a, b, c, color, [a[0], down ? y + 10 : y - 10, a[2]]);
  }
}

function addPitched(roof: Buf, walls: Buf, ring: Vec2[], shape: RoofShape, top: number, rh: number, roofCol: [number, number, number], wallOpts: WallOpts) {
  const c = centroid(ring);
  const ang = principalAngle(ring);
  const plan = ring.map((p) => rotatePoint(p, ang, c));
  const bb = bounds(plan);
  const over = 0.35;
  const x0 = bb.minX - over, x1 = bb.maxX + over, y0 = bb.minY - over, y1 = bb.maxY + over;
  const ym = (y0 + y1) / 2;
  const W = x1 - x0, D = y1 - y0;
  const back = (p: Vec2) => rotatePoint(p, -ang, c);
  const P = (x: number, y: number, h: number) => { const q = back([x, y]); return [q[0], h, -q[1]]; };
  const H = top + rh;
  const core = [c[0], top - 1, -c[1]];
  const rt = (a: number[], b: number[], d: number[], col: [number, number, number]) => roof.tri(a, b, d, col, core);
  if (shape === 'gabled') {
    // Two slopes and two triangular gable ends.
    rt(P(x0, y0, top), P(x1, y0, top), P(x1, ym, H), roofCol);
    rt(P(x0, y0, top), P(x1, ym, H), P(x0, ym, H), roofCol);
    rt(P(x1, y1, top), P(x0, y1, top), P(x0, ym, H), roofCol);
    rt(P(x1, y1, top), P(x0, ym, H), P(x1, ym, H), roofCol);
    const wc = wallOpts.color;
    const ctr = [c[0], top, -c[1]];
    walls.tri(P(x0 + over, y1 - over, top), P(x0 + over, y0 + over, top), P(x0 + over, ym, H - over * (rh / (D / 2))), wc, ctr);
    walls.tri(P(x1 - over, y0 + over, top), P(x1 - over, y1 - over, top), P(x1 - over, ym, H - over * (rh / (D / 2))), wc, ctr);
  } else {
    // Hipped / pyramidal on the oriented rectangle.
    const inset = Math.min(D / 2, W / 2);
    const rx0 = shape === 'pyramidal' ? (x0 + x1) / 2 : x0 + inset, rx1 = shape === 'pyramidal' ? (x0 + x1) / 2 : x1 - inset;
    rt(P(x0, y0, top), P(x1, y0, top), P(rx1, ym, H), roofCol);
    rt(P(x0, y0, top), P(rx1, ym, H), P(rx0, ym, H), roofCol);
    rt(P(x1, y1, top), P(x0, y1, top), P(rx0, ym, H), roofCol);
    rt(P(x1, y1, top), P(rx0, ym, H), P(rx1, ym, H), roofCol);
    rt(P(x1, y0, top), P(x1, y1, top), P(rx1, ym, H), shade(roofCol, 0.92));
    rt(P(x0, y1, top), P(x0, y0, top), P(rx0, ym, H), shade(roofCol, 0.92));
  }
  // Underside of the eaves so the roof doesn't look paper-thin.
  const above = [c[0], top + 10, -c[1]];
  roof.tri(P(x0, y0, top), P(x1, y1, top), P(x1, y0, top), shade(roofCol, 0.5), above);
  roof.tri(P(x0, y0, top), P(x0, y1, top), P(x1, y1, top), shade(roofCol, 0.5), above);
}

function addDome(buf: Buf, ring: Vec2[], holes: Vec2[][] | undefined, top: number, rh: number, col: [number, number, number]) {
  const ctr = interiorPoint(ring, holes);
  let r = Infinity;
  for (let i = 0; i < ring.length; i++) r = Math.min(r, closestOnSegment(ctr, ring[i], ring[(i + 1) % ring.length]).dist);
  addFlat(buf, ring, holes, top, shade(col, 0.85));
  r *= 0.96;
  const h = Math.min(rh, r * 1.1);
  const seg = 20, rings = 8;
  const pt = (i: number, j: number) => {
    const th = (i / seg) * Math.PI * 2, ph = (j / rings) * (Math.PI / 2);
    return [ctr[0] + Math.cos(th) * Math.cos(ph) * r, top + Math.sin(ph) * h, -(ctr[1] + Math.sin(th) * Math.cos(ph) * r)];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c2 = pt(i + 1, j + 1), d = pt(i, j + 1);
      const o = [ctr[0], top, -ctr[1]];
      buf.tri(a, c2, b, col, o);
      if (j < rings - 1) buf.tri(a, d, c2, col, o);
    }
  }
}

// ---------------------------------------------------------------------------
// Details (doors, awnings, rooftop units)

function addBox(buf: Buf, cx: number, cy: number, w: number, d: number, y0: number, y1: number, ang: number, col: [number, number, number]) {
  const corners: Vec2[] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map((p) => {
    const q = rotatePoint(p as Vec2, ang);
    return [q[0] + cx, q[1] + cy];
  });
  const P = (p: Vec2, h: number) => [p[0], h, -p[1]];
  const mid = [cx, (y0 + y1) / 2, -cy];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    buf.tri(P(a, y0), P(b, y0), P(b, y1), shade(col, 0.9), mid);
    buf.tri(P(a, y0), P(b, y1), P(a, y1), shade(col, 0.9), mid);
  }
  buf.tri(P(corners[0], y1), P(corners[2], y1), P(corners[1], y1), col, mid);
  buf.tri(P(corners[0], y1), P(corners[3], y1), P(corners[2], y1), col, mid);
}

function addEntrance(buf: Buf, b: BuildingRecord, p: BuildingProfile, base: number, rng: ReturnType<typeof createRng>) {
  // Footprints are stored counter-clockwise, so (dy, -dx) is the outward normal.
  const idx = Math.min(b.front, b.fp.length - 1);
  const a = b.fp[idx], c = b.fp[(idx + 1) % b.fp.length];
  const dx = c[0] - a[0], dy = c[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 2.2) return;
  const ux = dx / L, uy = dy / L;
  const nx = uy, ny = -ux;
  const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
  const ang = Math.atan2(uy, ux);
  const doorW = p.cls === 'house' ? 1.0 : Math.min(2.2, L * 0.4);
  const doorH = p.cls === 'house' ? 2.2 : Math.min(2.8, p.floorHeight * 0.75);
  // Door slab (dark) and frame.
  addBox(buf, mx + nx * 0.06, my + ny * 0.06, doorW, 0.1, base, base + doorH, ang, [0.03, 0.035, 0.04]);
  addBox(buf, mx + nx * 0.1, my + ny * 0.1, doorW + 0.3, 0.12, base + doorH, base + doorH + 0.18, ang, [0.6, 0.58, 0.55]);
  if (p.storefront && L > 5 && p.floors >= 1) {
    const awn = hexToRgb(rng.pick(['#2f5d50', '#7a2e2e', '#2d3e66', '#6b5a2a', '#3a3a3a', '#8a4b1f']));
    const aw = Math.min(L * 0.75, 18);
    const h = base + Math.min(3.3, p.floorHeight * 0.85);
    addBox(buf, mx + nx * 0.7, my + ny * 0.7, aw, 1.4, h, h + 0.35, ang, awn);
  } else if (p.cls !== 'house' && p.floors > 2) {
    addBox(buf, mx + nx * 0.8, my + ny * 0.8, doorW + 1.6, 1.6, base + doorH + 0.25, base + doorH + 0.5, ang, [0.35, 0.36, 0.38]);
  }
  // Steps for houses.
  if (p.cls === 'house') addBox(buf, mx + nx * 0.6, my + ny * 0.6, 1.6, 1.0, base, base + 0.3, ang, [0.55, 0.53, 0.5]);
}

function addRooftopUnits(buf: Buf, ring: Vec2[], holes: Vec2[][] | undefined, top: number, p: BuildingProfile, rng: ReturnType<typeof createRng>) {
  const area = p.footprintArea;
  if (area < 250 || p.roofShape !== 'flat') return;
  const ang = principalAngle(ring);
  const bb = bounds(ring);
  const ctr = interiorPoint(ring, holes);
  const gray: [number, number, number] = [0.42, 0.43, 0.44];
  if (p.floors >= 8) {
    // Mechanical penthouse.
    const s = Math.min(Math.sqrt(area) * 0.35, 22);
    if (pointInPolygon([ctr[0] + s / 2, ctr[1]], ring) && pointInPolygon([ctr[0] - s / 2, ctr[1]], ring)) {
      addBox(buf, ctr[0], ctr[1], s, s * 0.7, top, top + 4.5, -ang, shade(hexToRgb(p.wallColor), 0.8));
    }
  }
  const n = Math.min(6, Math.floor(area / 400) + 1);
  for (let i = 0; i < n; i++) {
    const x = rng.range(bb.minX, bb.maxX), y = rng.range(bb.minY, bb.maxY);
    const w = rng.range(1.5, 3.5), d = rng.range(1.2, 2.5);
    const ok = [[-w, -d], [w, -d], [w, d], [-w, d]].every(([ox, oy]) => pointInPolygon([x + ox, y + oy], ring, holes));
    if (ok) addBox(buf, x, y, w, d, top, top + rng.range(1, 2.2), -ang, gray);
  }
}

// ---------------------------------------------------------------------------

export interface BuildingRange {
  id: string;
  wall: [number, number];
  roof: [number, number];
}

export interface BuildingMeshData {
  walls: BufOut;
  roofs: BufOut;
  details: BufOut;
  ranges: BuildingRange[];
}

function partExtent(part: BuildingPart, p: BuildingProfile) {
  const fh = p.floorHeight;
  const base = part.minHeight ?? (part.minLevel != null ? part.minLevel * fh : 0);
  const top = part.height ?? (part.levels != null ? part.levels * fh + (part.minLevel ?? 0) * 0 : p.height);
  const roofH = part.roofHeight ?? 0;
  return { base, top: Math.max(base + 0.5, part.height != null ? top - roofH : top), roofH };
}

function mapRoof(shape?: string): RoofShape {
  const s = (shape ?? '').toLowerCase();
  if (['dome', 'onion', 'round'].includes(s)) return 'dome';
  if (s === 'pyramidal' || s === 'cone') return 'pyramidal';
  if (s === 'gabled') return 'gabled';
  if (s === 'hipped') return 'hipped';
  return 'flat';
}

export function appendBuilding(b: BuildingRecord, walls: Buf, roofs: Buf, details: Buf, lod: { details: boolean; lite?: boolean } = { details: true }): BuildingRange {
  const p = deriveProfile(b);
  const rng = createRng(p.seed ^ 0x5bd1e995);
  const wallStart = walls.count, roofStart = roofs.count;
  const wc = hexToRgb(p.wallColor), rc = hexToRgb(p.roofColor);
  const seed = (hashString(b.id) % 1000) / 1000;
  const style = STYLE_INDEX[p.style];
  const bay = p.style === 'glass' ? 1.6 : p.style === 'parking' ? 6 : p.cls === 'house' ? 3.2 : 2.8;
  const base: Omit<WallOpts, 'base' | 'top' | 'rowOffset'> = {
    color: wc, style, windowRatio: p.windowRatio, floors: p.floors, floorHeight: p.floorHeight, storefront: p.storefront, seed, bay,
  };
  const outer = ensureCCW(b.fp);
  const holes = b.holes?.map((h) => ensureCW(h));
  const useParts = !!b.parts?.length && b.tags['render:outline'] !== 'yes';

  if (useParts) {
    for (const part of b.parts!) {
      const { base: pb, top, roofH } = partExtent(part, p);
      const pwc = part.colour ? hexToRgb(parseColour(part.colour) ?? p.wallColor) : wc;
      const prc = part.roofColour ? hexToRgb(parseColour(part.roofColour) ?? p.roofColor) : rc;
      const ring = ensureCCW(part.fp);
      const opts: WallOpts = { ...base, color: pwc, base: pb, top, rowOffset: pb / p.floorHeight, floors: Math.ceil(top / p.floorHeight), storefront: p.storefront && pb < 1 };
      addWalls(walls, ring, opts);
      for (const h of part.holes ?? []) addWalls(walls, ensureCW(h), opts);
      const shape = mapRoof(part.roofShape);
      const rh = roofH || (shape === 'flat' ? 0 : Math.min(8, Math.sqrt(polygonArea(ring)) * (shape === 'dome' ? 0.5 : 0.3)));
      if (shape === 'dome') addDome(roofs, ring, part.holes, top, rh, prc);
      else if (shape === 'pyramidal' && ring.length >= 3) {
        const ctr = interiorPoint(ring);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], c = ring[(i + 1) % ring.length];
          roofs.tri([a[0], top, -a[1]], [c[0], top, -c[1]], [ctr[0], top + rh, -ctr[1]], prc, [ctr[0], top - 1, -ctr[1]]);
        }
      } else addFlat(roofs, ring, part.holes, top, prc);
      if (pb > 0.5) addFlat(roofs, ring, part.holes, pb, shade(pwc, 0.6), true);
    }
  } else {
    const flat = p.roofShape === 'flat';
    const parapet = flat && p.height > 6 && !lod.lite ? 0.9 : 0;
    const opts: WallOpts = { ...base, base: p.minHeight, top: p.height + parapet, rowOffset: 0 };
    addWalls(walls, outer, opts);
    for (const h of holes ?? []) addWalls(walls, h, opts);
    if (parapet) {
      const inner: WallOpts = { ...opts, base: p.height, color: shade(wc, 0.7) };
      addWalls(walls, outer, inner, true);
    }
    if (p.roofShape === 'flat') addFlat(roofs, outer, holes, p.height, rc);
    else if (p.roofShape === 'dome') addDome(roofs, outer, holes, p.height, p.roofHeight, rc);
    else if (p.roofShape === 'pyramidal' && outer.length > 4) {
      const ctr = interiorPoint(outer);
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], c = outer[(i + 1) % outer.length];
        roofs.tri([a[0], p.height, -a[1]], [c[0], p.height, -c[1]], [ctr[0], p.height + p.roofHeight, -ctr[1]], rc, [ctr[0], p.height - 1, -ctr[1]]);
      }
    } else addPitched(roofs, walls, outer, p.roofShape, p.height, p.roofHeight, rc, { ...opts, top: p.height });
    if (p.minHeight > 0.5) addFlat(roofs, outer, holes, p.minHeight, shade(wc, 0.5), true);
    if (lod.details) addRooftopUnits(details, outer, holes, p.height, p, rng);
  }
  if (lod.details && p.minHeight < 1 && p.solid) addEntrance(details, b, p, 0, rng);
  return { id: b.id, wall: [wallStart, walls.count - wallStart], roof: [roofStart, roofs.count - roofStart] };
}

/**
 * Merge buildings into per-material buffers. `lite` is the low-detail state
 * LOD: no window shader attributes, parapets, doors, awnings or rooftop units.
 */
export function buildBuildingsMesh(buildings: BuildingRecord[], lite = false): BuildingMeshData {
  const walls = new Buf(!lite), roofs = new Buf(), details = new Buf();
  const ranges: BuildingRange[] = [];
  for (const b of buildings) {
    try {
      ranges.push(appendBuilding(b, walls, roofs, details, { details: !lite, lite }));
    } catch (err) {
      console.warn('building geometry failed', b.id, err);
    }
  }
  return { walls: walls.out(), roofs: roofs.out(), details: details.out(), ranges };
}

// ---------------------------------------------------------------------------
// Ground: roads, sidewalks, parks, water, trees

const GROUND_COLORS = {
  park: '#6d9a4f', grass: '#79a356', garden: '#6fa052', pitch: '#5b9447', water: '#4a7ea6', parking: '#5a5c60', plaza: '#cbc3b3',
  sidewalk: '#bcb7ad', asphalt: '#232528', footway: '#cfc6b5', pedestrian: '#d3cab8', rail: '#6a5d52', line: '#d9b23a', white: '#e8e8e8',
};
const AREA_Y: Record<string, number> = { water: 0.015, parking: 0.02, plaza: 0.025, grass: 0.03, park: 0.03, garden: 0.035, pitch: 0.04 };

function addRibbon(buf: Buf, pts: Vec2[], width: number, y: number, col: [number, number, number]) {
  if (pts.length < 2) return;
  const hw = width / 2;
  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    let nx = -ty, ny = tx;
    let scale = 1;
    if (i > 0 && i < pts.length - 1) {
      // Miter join, clamped.
      const ax = pts[i][0] - prev[0], ay = pts[i][1] - prev[1];
      const al = Math.hypot(ax, ay) || 1;
      const n1x = -ay / al, n1y = ax / al;
      const dot = nx * n1x + ny * n1y;
      scale = Math.min(2.5, 1 / Math.max(0.4, dot));
    }
    nx *= hw * scale; ny *= hw * scale;
    left.push([pts[i][0] + nx, pts[i][1] + ny]);
    right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  const up: [number, number, number] = [0, 1, 0];
  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = left[i], l1 = left[i + 1], r0 = right[i], r1 = right[i + 1];
    // Counter-clockwise from above in three space (x, -y).
    for (const p of [r0, r1, l1, r0, l1, l0]) buf.vert(p[0], y, -p[1], up, col);
  }
}

function addDashes(buf: Buf, pts: Vec2[], width: number, y: number, col: [number, number, number], dash = 3, gap = 6) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = 0;
    while (L - t > 1e-3) {
      const phase = acc % (dash + gap);
      // Never step by less than a millimeter, or float rounding can stall the loop.
      const run = Math.max(1e-3, phase < dash ? Math.min(dash - phase, L - t) : Math.min(dash + gap - phase, L - t));
      if (phase < dash) {
        const p0: Vec2 = [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
        const p1: Vec2 = [a[0] + ((b[0] - a[0]) * (t + run)) / L, a[1] + ((b[1] - a[1]) * (t + run)) / L];
        addRibbon(buf, [p0, p1], width, y, col);
      }
      t += run;
      acc += run;
    }
  }
}

export interface GroundMeshData {
  ground: BufOut;
  trees: Float32Array; // x, y(north), scale, variant
}

export function buildGroundMesh(tile: TileData, lite = false): GroundMeshData {
  const buf = new Buf();
  const C = Object.fromEntries(Object.entries(GROUND_COLORS).map(([k, v]) => [k, hexToRgb(v)])) as Record<keyof typeof GROUND_COLORS, [number, number, number]>;
  const trees: number[] = [];
  for (const a of tile.areas) {
    try {
      addFlat(buf, a.fp, a.holes, AREA_Y[a.kind] ?? 0.03, C[a.kind as keyof typeof C] ?? C.grass);
    } catch { /* skip degenerate area */ }
    if (!lite && (a.kind === 'park' || a.kind === 'grass' || a.kind === 'garden')) {
      const area = polygonArea(a.fp);
      const rng = createRng(hashString(a.id));
      const bb = bounds(a.fp);
      const n = Math.min(120, Math.floor(area / 160));
      for (let i = 0; i < n * 3 && trees.length / 4 < 4000; i++) {
        const p: Vec2 = [rng.range(bb.minX, bb.maxX), rng.range(bb.minY, bb.maxY)];
        if (pointInPolygon(p, a.fp, a.holes) && rng.chance(0.34)) trees.push(p[0], p[1], rng.range(0.8, 1.35), rng.int(0, 2));
      }
    }
  }
  const order: Record<string, number> = { footway: 0, cycleway: 0, steps: 0, rail: 1, pedestrian: 1, service: 2, residential: 3, tertiary: 4, secondary: 5, primary: 6, trunk: 7, motorway: 8 };
  const roads = [...tile.roads].sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
  for (const r of roads) if (r.sidewalk) addRibbon(buf, r.pts, r.width + 5.5, 0.05, C.sidewalk);
  for (const r of roads) {
    const y = 0.07 + (order[r.kind] ?? 0) * 0.002;
    switch (r.kind) {
      case 'footway': case 'cycleway': case 'steps':
        addRibbon(buf, r.pts, r.width, 0.06, C.footway); break;
      case 'pedestrian':
        addRibbon(buf, r.pts, r.width, 0.062, C.pedestrian); break;
      case 'rail':
        addRibbon(buf, r.pts, 2.8, 0.06, C.rail); break;
      default:
        addRibbon(buf, r.pts, r.width, y, C.asphalt);
        if (['primary', 'secondary', 'tertiary', 'trunk'].includes(r.kind)) {
          if (lite) break;
          if (r.oneway) addDashes(buf, r.pts, 0.15, y + 0.01, C.white);
          else addRibbon(buf, r.pts, 0.25, y + 0.01, C.line);
        }
    }
  }
  for (const t of tile.trees) trees.push(t[0], t[1], 1, hashString(`${t[0]},${t[1]}`) % 3);
  return { ground: buf.out(), trees: new Float32Array(trees) };
}

/** Re-center positions on a tile origin (x east, y north) to keep float32 precision far from the region origin. */
export function offsetBuf(b: BufOut, ox: number, oy: number) {
  const p = b.position;
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= ox;
    p[i + 2] += oy;
  }
}
