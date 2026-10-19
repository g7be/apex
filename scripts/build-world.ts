// Converts a raw Overpass download (data/raw/<region>.osm.json) into the
// static tiled world format served to clients (data/world/<region>/).
//
// Usage: npx tsx scripts/build-world.ts [regionId]
//
// Output is deterministic for a given input file, so building ids, geometry and
// procedural seeds are stable across rebuilds.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import {
  createProjection, lonLatToTile, tileToLonLatBounds, tileKey,
  centroid, cleanRing, closestOnSegment, ensureCCW, ensureCW, polygonArea, pointInPolygon, interiorPoint,
  type AreaKind, type AreaRecord, type BuildingPart, type BuildingRecord, type RoadKind, type RoadRecord, type TileData,
  type TileInfo, type Vec2, type WorldManifest, parseLength,
} from '@indy/shared';

export const GENERATOR_VERSION = 1;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const regionId = process.argv[2] ?? 'indianapolis-downtown';
const regions = JSON.parse(await readFile(path.join(root, 'data/regions.json'), 'utf8'));
const region = regions[regionId];
const rawFile = path.join(root, `data/raw/${regionId}.osm.json`);
const cacheDir = path.join(root, 'data/raw/cache', regionId);
let raw: { attribution?: string; fetchedAt?: string; elements: unknown[] };
if (existsSync(rawFile)) {
  raw = JSON.parse(await readFile(rawFile, 'utf8'));
} else if (existsSync(cacheDir)) {
  // An interrupted download: merge whatever cells are cached so far.
  const { readdir } = await import('node:fs/promises');
  const byKey = new Map<string, { type: string; id: number }>();
  const files = (await readdir(cacheDir)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    for (const el of JSON.parse(await readFile(path.join(cacheDir, f), 'utf8')).elements) byKey.set(`${el.type}/${el.id}`, el);
  }
  console.warn(`⚠ ${path.relative(root, rawFile)} not found; building from ${files.length} cached cells (partial data).`);
  raw = { elements: [...byKey.values()], fetchedAt: new Date().toISOString() };
} else {
  console.error(`Missing ${path.relative(root, rawFile)}. Run "npm run data:fetch" first.`);
  process.exit(1);
}
const proj = createProjection(region.origin);
const Z = region.tileZoom as number;
const [S, Wb, N, E] = region.bbox as number[];

type LatLon = { lat: number; lon: number };
interface OsmEl {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: (LatLon | null)[];
  members?: { type: string; ref: number; role: string; geometry?: (LatLon | null)[] }[];
}
const elements = raw.elements as OsmEl[];

const r2 = (v: number) => Math.round(v * 100) / 100;
const toLocal = (g: LatLon): Vec2 => {
  const [x, y] = proj.toLocal(g.lat, g.lon);
  return [r2(x), r2(y)];
};
const inBbox = (g: LatLon) => g.lat >= S && g.lat <= N && g.lon >= Wb && g.lon <= E;

// ---------------------------------------------------------------------------
// Ring assembly

function assembleRings(lines: LatLon[][]): LatLon[][] {
  const key = (g: LatLon) => `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
  const pool = lines.filter((l) => l.length >= 2).map((l) => [...l]);
  const rings: LatLon[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 500) {
      const end = key(cur[cur.length - 1]);
      const idx = pool.findIndex((l) => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (idx < 0) break;
      const next = pool.splice(idx, 1)[0];
      cur = key(next[0]) === end ? [...cur, ...next.slice(1)] : [...cur, ...next.reverse().slice(1)];
    }
    if (key(cur[0]) === key(cur[cur.length - 1]) && cur.length >= 4) rings.push(cur.slice(0, -1));
  }
  return rings;
}

interface Shape { outer: Vec2[]; holes: Vec2[][] }

function prepRing(ring: LatLon[]): Vec2[] | null {
  const pts = cleanRing(ring.map(toLocal), 0.05);
  if (pts.length < 3 || polygonArea(pts) < 2) return null;
  return pts;
}

function shapesOf(el: OsmEl): Shape[] {
  if (el.type === 'way') {
    const g = el.geometry?.filter(Boolean) as LatLon[] | undefined;
    if (!g || g.length < 4 || el.nodes?.[0] !== el.nodes?.[el.nodes.length - 1]) return [];
    const outer = prepRing(g.slice(0, -1));
    return outer ? [{ outer: ensureCCW(outer), holes: [] }] : [];
  }
  if (el.type === 'relation' && el.tags?.type === 'multipolygon') {
    const geo = (role: string) => (el.members ?? [])
      .filter((m) => m.type === 'way' && (m.role || 'outer') === role && m.geometry?.every(Boolean))
      .map((m) => m.geometry as LatLon[]);
    const outers = assembleRings(geo('outer')).map(prepRing).filter(Boolean).map((r) => ensureCCW(r!));
    const inners = assembleRings(geo('inner')).map(prepRing).filter(Boolean).map((r) => ensureCW(r!));
    return outers.map((outer) => ({ outer, holes: inners.filter((h) => pointInPolygon(h[0], outer)) }));
  }
  return [];
}

const KEEP_TAGS = /^(building|building:levels|building:min_level|height|min_height|roof:shape|roof:height|roof:levels|roof:colour|building:colour|building:material|amenity|shop|office|tourism|historic|leisure|name|official_name|start_date|wikidata|wikipedia|government|parking|religion|denomination|operator|website|addr:.*|architect|heritage)$/;
const filterTags = (t: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => KEEP_TAGS.test(k)));

// ---------------------------------------------------------------------------
// Roads

const ROAD_KIND: Record<string, RoadKind> = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'trunk', trunk_link: 'trunk',
  primary: 'primary', primary_link: 'primary', secondary: 'secondary', secondary_link: 'secondary',
  tertiary: 'tertiary', tertiary_link: 'tertiary', residential: 'residential', unclassified: 'residential',
  living_street: 'residential', service: 'service', pedestrian: 'pedestrian', footway: 'footway', path: 'footway',
  cycleway: 'cycleway', steps: 'steps', track: 'service', corridor: 'footway',
};
const ROAD_WIDTH: Record<RoadKind, number> = {
  motorway: 14, trunk: 13, primary: 13, secondary: 11.5, tertiary: 10, residential: 8, service: 5,
  pedestrian: 6, footway: 2.4, cycleway: 2.6, steps: 2.4, rail: 3,
};
const VEHICLE: ReadonlySet<RoadKind> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service']);

const roads: RoadRecord[] = [];
const areas: AreaRecord[] = [];
const trees: Vec2[] = [];
const buildingsRaw: { el: OsmEl; shape: Shape }[] = [];
const partsRaw: { el: OsmEl; shape: Shape }[] = [];
const neighborhoods: WorldManifest['neighborhoods'] = [];
const landmarkNodes: WorldManifest['landmarks'] = [];

function areaKind(t: Record<string, string>): AreaKind | null {
  if (t.leisure === 'park' || t.leisure === 'playground' || t.leisure === 'dog_park' || t.leisure === 'common') return 'park';
  if (t.leisure === 'garden') return 'garden';
  if (t.leisure === 'pitch' || t.leisure === 'track') return 'pitch';
  if (['grass', 'recreation_ground', 'village_green', 'meadow', 'forest', 'flowerbed', 'cemetery'].includes(t.landuse ?? '')) return 'grass';
  if (['wood', 'scrub', 'grassland', 'heath'].includes(t.natural ?? '')) return 'grass';
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.leisure === 'swimming_pool' || t.landuse === 'basin') return 'water';
  if (t.amenity === 'parking' && !t.building && t.parking !== 'multi-storey' && t.parking !== 'underground') return 'parking';
  if (t.highway === 'pedestrian' && t.area === 'yes') return 'plaza';
  if (t.place === 'square' || t.leisure === 'plaza' || t['area:highway'] === 'pedestrian') return 'plaza';
  return null;
}

for (const el of elements) {
  const t = el.tags ?? {};
  if (el.type === 'node') {
    if (el.lat == null || el.lon == null) continue;
    if (t.natural === 'tree' && inBbox(el as LatLon)) trees.push(toLocal(el as LatLon));
    if (t.place && t.name) neighborhoods.push({ name: t.name, pos: toLocal(el as LatLon) });
    if (t.name && (t.historic || t.tourism === 'attraction' || t.tourism === 'museum' || t.tourism === 'artwork') && inBbox(el as LatLon)) {
      landmarkNodes.push({ name: t.name, pos: toLocal(el as LatLon), kind: t.historic ?? t.tourism });
    }
    continue;
  }
  if (t.building && t.building !== 'no') {
    for (const shape of shapesOf(el)) buildingsRaw.push({ el, shape });
    continue;
  }
  if (t['building:part'] && t['building:part'] !== 'no') {
    for (const shape of shapesOf(el)) partsRaw.push({ el, shape });
    continue;
  }
  const ak = areaKind(t);
  if (ak) {
    for (const shape of shapesOf(el)) {
      areas.push({ id: `osm:${el.type[0]}${el.id}`, kind: ak, name: t.name, fp: shape.outer, holes: shape.holes.length ? shape.holes : undefined });
    }
    continue;
  }
  if (el.type === 'way' && (t.highway || ['rail', 'light_rail', 'tram'].includes(t.railway ?? ''))) {
    if (t.area === 'yes' || t.tunnel === 'yes' || t.tunnel === 'building_passage' || t.indoor === 'yes') continue;
    const kind: RoadKind | undefined = t.railway ? 'rail' : ROAD_KIND[t.highway];
    if (!kind) continue;
    const g = (el.geometry ?? []).filter(Boolean) as LatLon[];
    if (g.length < 2) continue;
    const lanes = parseFloat(t.lanes);
    const width = parseLength(t.width) ?? (Number.isFinite(lanes) && VEHICLE.has(kind) && kind !== 'service' ? Math.max(6, lanes * 3.3 + 1) : ROAD_WIDTH[kind]);
    roads.push({
      id: `osm:w${el.id}`,
      kind,
      name: t.name,
      width: Math.min(width, 30),
      sidewalk: VEHICLE.has(kind) && kind !== 'service' && t.sidewalk !== 'no' && t.sidewalk !== 'none',
      oneway: t.oneway === 'yes' || undefined,
      bridge: t.bridge === 'yes' || undefined,
      pts: g.map(toLocal),
    });
  }
}

// ---------------------------------------------------------------------------
// Spatial grid over road segments (for entrance edges and street names)

const CELL = 50;
const roadGrid = new Map<string, { a: Vec2; b: Vec2; road: RoadRecord }[]>();
for (const road of roads) {
  if (!VEHICLE.has(road.kind) && road.kind !== 'pedestrian') continue;
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i], b = road.pts[i + 1];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      if (!roadGrid.has(k)) roadGrid.set(k, []);
      roadGrid.get(k)!.push({ a, b, road });
    }
  }
}

function nearestRoad(p: Vec2, maxDist = 80, preferName?: string) {
  let best: { dist: number; road: RoadRecord; point: Vec2 } | null = null;
  const r = Math.ceil(maxDist / CELL);
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  const seen = new Set<object>();
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
    for (const seg of roadGrid.get(`${x},${y}`) ?? []) {
      if (seen.has(seg)) continue;
      seen.add(seg);
      const c = closestOnSegment(p, seg.a, seg.b);
      // Small bias toward the addressed street and toward named, bigger roads.
      const bias = (preferName && seg.road.name === preferName ? -12 : 0) + (seg.road.name ? 0 : 6) + (seg.road.kind === 'service' ? 8 : 0);
      const d = c.dist + bias;
      if (c.dist <= maxDist && (!best || d < best.dist)) best = { dist: d, road: seg.road, point: c.point };
    }
  }
  return best;
}

function frontEdge(fp: Vec2[], preferStreet?: string): { index: number; street?: string } {
  let best = { index: 0, score: Infinity, street: undefined as string | undefined };
  const ccw = ensureCCW(fp);
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i], b = ccw[(i + 1) % ccw.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2.5) continue;
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // Outward normal of a CCW ring is (dy, -dx).
    const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
    const probe: Vec2 = [m[0] + nx * 1.5, m[1] + ny * 1.5];
    const nr = nearestRoad(probe, 80, preferStreet);
    if (!nr) continue;
    const toRoad = [nr.point[0] - m[0], nr.point[1] - m[1]];
    const tl = Math.hypot(toRoad[0], toRoad[1]) || 1;
    const facing = (toRoad[0] * nx + toRoad[1] * ny) / tl; // 1 = faces the road
    const score = nr.dist - facing * 8 - Math.min(len, 30) * 0.15;
    if (score < best.score) best = { index: i, score, street: nr.road.name };
  }
  return { index: best.index, street: best.street };
}

// ---------------------------------------------------------------------------
// Buildings

const buildings: BuildingRecord[] = [];
const seenIds = new Set<string>();
for (const { el, shape } of buildingsRaw) {
  const c = centroid(shape.outer);
  const g = proj.toGeo(c[0], c[1]);
  if (!inBbox(g)) continue;
  let id = `osm:${el.type[0]}${el.id}`;
  if (seenIds.has(id)) id = `${id}-${seenIds.size}`; // multipolygon with several outers
  seenIds.add(id);
  const t = el.tags ?? {};
  const addrStreet = t['addr:street'];
  const fe = frontEdge(shape.outer, addrStreet);
  buildings.push({
    id,
    osm: `${el.type}/${el.id}`,
    fp: shape.outer,
    holes: shape.holes.length ? shape.holes : undefined,
    tags: filterTags(t),
    name: t.name ?? t.official_name,
    address: t['addr:housenumber'] && addrStreet ? `${t['addr:housenumber']} ${addrStreet}` : undefined,
    front: fe.index,
    street: addrStreet ?? fe.street,
    centroid: [r2(c[0]), r2(c[1])],
  });
}

// Attach building:parts to the building whose outline contains them.
const bGrid = new Map<string, BuildingRecord[]>();
for (const b of buildings) {
  const xs = b.fp.map((p) => p[0]), ys = b.fp.map((p) => p[1]);
  for (let x = Math.floor(Math.min(...xs) / CELL); x <= Math.floor(Math.max(...xs) / CELL); x++)
    for (let y = Math.floor(Math.min(...ys) / CELL); y <= Math.floor(Math.max(...ys) / CELL); y++) {
      const k = `${x},${y}`;
      if (!bGrid.has(k)) bGrid.set(k, []);
      bGrid.get(k)!.push(b);
    }
}
let attachedParts = 0;
for (const { el, shape } of partsRaw) {
  const p = interiorPoint(shape.outer);
  const cands = bGrid.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? [];
  const host = cands.find((b) => pointInPolygon(p, b.fp, b.holes));
  if (!host) continue;
  const t = el.tags ?? {};
  const levels = t['building:levels'] ? parseFloat(t['building:levels']) : undefined;
  const minLevel = t['building:min_level'] ? parseFloat(t['building:min_level']) : undefined;
  const part: BuildingPart = {
    fp: shape.outer,
    holes: shape.holes.length ? shape.holes : undefined,
    height: parseLength(t.height),
    minHeight: parseLength(t.min_height),
    levels: Number.isFinite(levels) ? levels : undefined,
    minLevel: Number.isFinite(minLevel) ? minLevel : undefined,
    roofShape: t['roof:shape'],
    roofHeight: parseLength(t['roof:height']),
    colour: t['building:colour'],
    roofColour: t['roof:colour'],
  };
  (host.parts ??= []).push(part);
  attachedParts++;
}
// Keep the outline visible when parts cover only a portion of it.
for (const b of buildings) {
  if (!b.parts?.length) continue;
  const toPoly = (r: Vec2[]): [number, number][][] => [[...r.map((p) => [p[0], p[1]] as [number, number]), [r[0][0], r[0][1]]]];
  try {
    const u = polygonClipping.union(toPoly(b.parts[0].fp), ...b.parts.slice(1).map((p) => toPoly(p.fp)));
    const covered = polygonClipping.intersection(u, toPoly(b.fp));
    const area = covered.reduce((s, poly) => s + polygonArea(poly[0].slice(0, -1) as Vec2[]), 0);
    if (area < polygonArea(b.fp) * 0.85) b.tags['render:outline'] = 'yes';
  } catch {
    b.tags['render:outline'] = 'yes';
  }
}

// ---------------------------------------------------------------------------
// Tiling

const tiles = new Map<string, TileData & { z: number; x: number; y: number }>();
function tileFor(p: Vec2) {
  const g = proj.toGeo(p[0], p[1]);
  const t = lonLatToTile(g.lon, g.lat, Z);
  const key = tileKey(Z, t.x, t.y);
  if (!tiles.has(key)) tiles.set(key, { key, z: Z, x: t.x, y: t.y, buildings: [], roads: [], areas: [], trees: [] });
  return tiles.get(key)!;
}
for (const b of buildings) tileFor(b.centroid).buildings.push(b);
for (const a of areas) {
  const c = centroid(a.fp);
  if (!inBbox(proj.toGeo(c[0], c[1]))) continue;
  tileFor(c).areas.push(a);
}
for (const t of trees) tileFor(t).trees.push(t);
// Split roads into per-tile runs of consecutive segments.
let roadPieces = 0;
for (const road of roads) {
  let run: Vec2[] = [road.pts[0]];
  let runTile: string | null = null;
  const flush = () => {
    if (run.length >= 2 && runTile) {
      tiles.get(runTile)!.roads.push({ ...road, id: `${road.id}#${roadPieces++}`, pts: run });
    }
  };
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i], b = road.pts[i + 1];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inBbox(proj.toGeo(mid[0], mid[1]))) { flush(); run = [b]; runTile = null; continue; }
    const key = tileFor(mid).key;
    if (runTile && key !== runTile) { flush(); run = [a]; }
    runTile = key;
    run.push(b);
  }
  flush();
}

// ---------------------------------------------------------------------------
// Spawn point: on a street near the origin, outside every building.

function insideAnyBuilding(p: Vec2, margin = 2) {
  const cands = bGrid.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? [];
  return cands.some((b) => pointInPolygon(p, b.fp) || b.fp.some((q, i) => closestOnSegment(p, q, b.fp[(i + 1) % b.fp.length]).dist < margin));
}
let spawn: Vec2 = [0, -60];
search: for (let r = 30; r <= 200; r += 5) {
  for (let k = 0; k < 24; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 24;
    const p: Vec2 = [Math.cos(a) * r, Math.sin(a) * r];
    const nr = nearestRoad(p, 6);
    if (nr && !insideAnyBuilding(p)) { spawn = [r2(p[0]), r2(p[1])]; break search; }
  }
}

// ---------------------------------------------------------------------------
// Write output

const outDir = path.join(root, 'data/world', regionId);
await rm(path.join(outDir, 'tiles'), { recursive: true, force: true });
await mkdir(path.join(outDir, 'tiles'), { recursive: true });

const tileInfos: TileInfo[] = [];
const sortById = <T extends { id: string }>(arr: T[]) => arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
for (const t of [...tiles.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
  const gb = tileToLonLatBounds(t.x, t.y, t.z);
  const [minX, minY] = proj.toLocal(gb.south, gb.west);
  const [maxX, maxY] = proj.toLocal(gb.north, gb.east);
  const data: TileData = { key: t.key, buildings: sortById(t.buildings), roads: sortById(t.roads), areas: sortById(t.areas), trees: t.trees };
  const file = `tiles/${t.key}.json`;
  await writeFile(path.join(outDir, file), JSON.stringify(data));
  tileInfos.push({ key: t.key, z: t.z, x: t.x, y: t.y, bounds: [r2(minX), r2(minY), r2(maxX), r2(maxY)], buildings: t.buildings.length, file });
}

const [bx0, by0] = proj.toLocal(S, Wb);
const [bx1, by1] = proj.toLocal(N, E);
const landmarks = [
  ...buildings.filter((b) => b.name && (b.tags.historic || b.tags.tourism || b.tags.wikidata)).map((b) => ({ name: b.name!, pos: b.centroid, kind: 'building' })),
  ...landmarkNodes,
];
const manifest: WorldManifest = {
  region: regionId,
  name: region.name,
  origin: region.origin,
  tileZoom: Z,
  bounds: [r2(bx0), r2(by0), r2(bx1), r2(by1)],
  attribution: raw.attribution ?? '© OpenStreetMap contributors (ODbL)',
  source: { fetchedAt: raw.fetchedAt ?? new Date().toISOString(), dataset: 'OpenStreetMap via Overpass API' },
  generatorVersion: GENERATOR_VERSION,
  tiles: tileInfos,
  neighborhoods: neighborhoods.sort((a, b) => a.name.localeCompare(b.name)),
  landmarks: landmarks.sort((a, b) => a.name.localeCompare(b.name)),
  spawn,
  stats: { buildings: buildings.length, roads: roads.length, areas: areas.length, trees: trees.length },
};
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
await writeFile(path.join(outDir, 'ATTRIBUTION.md'), `# Data attribution

Geographic data in this directory is derived from OpenStreetMap.

${manifest.attribution}

Fetched: ${raw.fetchedAt}. Processed by scripts/build-world.ts (generator v${GENERATOR_VERSION}).
Building interiors, rents and tenants in the game are fictional and procedurally generated.
`);

console.log(`World "${regionId}": ${buildings.length} buildings (${attachedParts} parts), ${roads.length} roads, ${areas.length} areas, ${trees.length} trees, ${neighborhoods.length} neighborhoods, ${tileInfos.length} tiles. Spawn ${spawn}.`);
