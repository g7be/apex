// 2D polygon helpers. Rings are open (first point is not repeated).
import type { Vec2 } from './geo.ts';

export type Ring = Vec2[];

export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export const polygonArea = (ring: Ring) => Math.abs(signedArea(ring));

export function ensureCCW(ring: Ring): Ring {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}
export function ensureCW(ring: Ring): Ring {
  return signedArea(ring) > 0 ? [...ring].reverse() : ring;
}

export function centroid(ring: Ring): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const s = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Vec2, [0, 0] as Vec2);
    return [s[0] / ring.length, s[1] / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function perimeter(ring: Ring): number {
  let p = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

export function bounds(ring: Ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  const [px, py] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Vec2, outer: Ring, holes: Ring[] = []): boolean {
  if (!pointInRing(p, outer)) return false;
  return !holes.some((h) => pointInRing(p, h));
}

/** Closest point on segment ab to p, plus distance. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; dist: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return { point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]), t };
}

export function distanceToRing(p: Vec2, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]).dist;
    if (d < best) best = d;
  }
  return best;
}

/** Remove duplicate and nearly collinear vertices. */
export function cleanRing(ring: Ring, eps = 0.05): Ring {
  let pts = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > eps;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len < eps) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function rotatePoint(p: Vec2, angle: number, about: Vec2 = [0, 0]): Vec2 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const x = p[0] - about[0], y = p[1] - about[1];
  return [about[0] + x * c - y * s, about[1] + x * s + y * c];
}

export const rotateRing = (ring: Ring, angle: number, about: Vec2 = [0, 0]): Ring =>
  ring.map((p) => rotatePoint(p, angle, about));

/**
 * Orientation of the building: the edge direction whose aligned bounding box
 * has minimal area (an approximation of the minimum-area rectangle), with the
 * long side mapped to +x. Returns the angle to rotate the ring by so it is
 * axis-aligned.
 */
export function principalAngle(ring: Ring): number {
  let best = { area: Infinity, angle: 0 };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    const r = rotateRing(ring, angle);
    const bb = bounds(r);
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    const area = w * h;
    if (area < best.area - 1e-6) best = { area, angle: w >= h ? angle : angle + Math.PI / 2 };
  }
  // Normalize to (-pi/2, pi/2] so the generated plan is never upside down.
  let a = best.angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** Ratio of polygon area to its oriented bounding-box area (1 = rectangle). */
export function rectangularity(ring: Ring): number {
  const r = rotateRing(ring, principalAngle(ring));
  const bb = bounds(r);
  return polygonArea(ring) / Math.max(1e-6, (bb.maxX - bb.minX) * (bb.maxY - bb.minY));
}

/**
 * Approximate pole of inaccessibility: a point well inside the polygon. Uses a
 * coarse grid refined around the best candidate. Always returns an interior
 * point for valid polygons.
 */
export function interiorPoint(ring: Ring, holes: Ring[] = []): Vec2 {
  const c = centroid(ring);
  if (pointInPolygon(c, ring, holes) && distanceToRing(c, ring) > 1) return c;
  const bb = bounds(ring);
  let best: Vec2 = c, bestD = -Infinity;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p: Vec2 = [bb.minX + ((bb.maxX - bb.minX) * i) / steps, bb.minY + ((bb.maxY - bb.minY) * j) / steps];
      if (!pointInPolygon(p, ring, holes)) continue;
      const d = Math.min(distanceToRing(p, ring), ...holes.map((h) => distanceToRing(p, h)));
      if (d > bestD) { bestD = d; best = p; }
    }
  }
  return best;
}

/** Douglas–Peucker simplification of an open polyline. */
export function simplifyLine(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = closestOnSegment(pts[i], pts[a], pts[b]).dist;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (open representation); returns null if it collapses. */
export function simplifyRing(ring: Ring, tolerance: number): Ring | null {
  if (ring.length <= 4) return ring;
  // Split at the vertex farthest from the first one so both halves are well-conditioned.
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) { farD = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tolerance);
  const b = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : null;
}
