// Imports a whole state from a Geofabrik OSM extract (.osm.pbf) into
// multi-level-of-detail tiles, and also emits the raw city-region data that
// scripts/build-world.ts turns into the full-detail downtown.
//
// Usage: npx tsx scripts/import-state.ts [stateId]      (default: indiana)
// Memory: node coordinates live in compact typed arrays; features are spooled
// to per-tile temp files, so a multi-million-building state fits comfortably.
//
// Data © OpenStreetMap contributors, ODbL 1.0.
import { createOSMStream } from 'osm-pbf-parser-node';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  centroid, cleanRing, closestOnSegment, createProjection, ensureCCW, ensureCW, lonLatToTile, parseLength, pointInRing,
  polygonArea, simplifyLine, simplifyRing,
  type AreaRecord, type BuildingRecord, type LineFeature, type LineKind, type MapTile, type PlaceLabel, type PolyFeature,
  type RoadKind, type RoadRecord, type StateManifest, type TileData, type Vec2,
} from '@indy/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateId = process.argv[2] ?? 'indiana';
const regions = JSON.parse(readFileSync(path.join(root, 'data/regions.json'), 'utf8'));
const state = regions[stateId];
if (!state?.pbf) throw new Error(`Region ${stateId} has no "pbf" in data/regions.json`);
const pbfFile = path.join(root, state.pbf);
if (!existsSync(pbfFile)) {
  console.error(`Missing ${state.pbf}. Download it first, e.g. from https://download.geofabrik.de/`);
  process.exit(1);
}
const city = state.detailRegion ? regions[state.detailRegion] : null;
const Z = state.layers as { overview: number; mid: number; detail: number };
const proj = createProjection(state.origin);
const outDir = path.join(root, 'data/world', stateId);
const tmpDir = path.join(outDir, '_tmp');
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);

// ---------------------------------------------------------------------------
// Compact node store: ids arrive sorted in .osm.pbf files.

const CHUNK = 1 << 20;
const idChunks: Float64Array[] = [];
const latChunks: Int32Array[] = [];
const lonChunks: Int32Array[] = [];
const chunkFirst: number[] = [];
let nodeCount = 0;
let lastNodeId = -Infinity;

function addNode(id: number, lat: number, lon: number) {
  if (id <= lastNodeId) throw new Error('Nodes are not sorted by id; re-sort the file with osmium sort.');
  lastNodeId = id;
  const c = nodeCount >> 20, i = nodeCount & (CHUNK - 1);
  if (i === 0) {
    idChunks.push(new Float64Array(CHUNK));
    latChunks.push(new Int32Array(CHUNK));
    lonChunks.push(new Int32Array(CHUNK));
    chunkFirst.push(id);
  }
  idChunks[c][i] = id;
  latChunks[c][i] = Math.round(lat * 1e7);
  lonChunks[c][i] = Math.round(lon * 1e7);
  nodeCount++;
}

/** Returns [lat, lon] or null. */
function getNode(id: number): [number, number] | null {
  let lo = 0, hi = chunkFirst.length - 1, c = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (chunkFirst[m] <= id) { c = m; lo = m + 1; } else hi = m - 1;
  }
  if (c < 0) return null;
  const ids = idChunks[c];
  const n = c === idChunks.length - 1 ? ((nodeCount - 1) & (CHUNK - 1)) + 1 : CHUNK;
  lo = 0; hi = n - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const v = ids[m];
    if (v === id) return [latChunks[c][m] / 1e7, lonChunks[c][m] / 1e7];
    if (v < id) lo = m + 1; else hi = m - 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spooling features into per-tile temp files.

type LayerName = 'overview' | 'mid' | 'detail';
const buffers = new Map<string, string[]>();
const tileSets: Record<LayerName, Set<string>> = { overview: new Set(), mid: new Set(), detail: new Set() };
function spool(layer: LayerName, key: string, obj: unknown) {
  tileSets[layer].add(key);
  const k = `${layer}/${key}`;
  let b = buffers.get(k);
  if (!b) buffers.set(k, (b = []));
  b.push(JSON.stringify(obj));
  if (b.length >= 400) flushBuffer(k);
}
function flushBuffer(k: string) {
  const b = buffers.get(k);
  if (!b?.length) return;
  appendFileSync(path.join(tmpDir, `${k.replace('/', '__')}.ndjson`), b.join('\n') + '\n');
  buffers.set(k, []);
}
function flushAll() {
  for (const k of buffers.keys()) flushBuffer(k);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const toLocal = (lat: number, lon: number): Vec2 => proj.toLocal(lat, lon);
const tileOfLocal = (p: Vec2, z: number) => {
  const g = proj.toGeo(p[0], p[1]);
  const t = lonLatToTile(g.lon, g.lat, z);
  return `${t.x}-${t.y}`;
};

// City region bbox (lat/lon) and its local-meter equivalent.
const cityBox = city?.bbox as [number, number, number, number] | undefined;
const cityPlacesBox = (city?.placesBbox ?? city?.bbox) as [number, number, number, number] | undefined;
const inBox = (lat: number, lon: number, b?: number[]) => !!b && lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const inCityLocal = (p: Vec2) => {
  if (!cityBox) return false;
  const g = proj.toGeo(p[0], p[1]);
  return inBox(g.lat, g.lon, cityBox);
};

/** Split a polyline into runs per tile (by segment midpoint), skipping the city region if asked. */
function splitByTile(pts: Vec2[], z: number, skipCity: boolean): [string, Vec2[]][] {
  const out: [string, Vec2[]][] = [];
  let run: Vec2[] = [];
  let runKey: string | null = null;
  const flush = () => { if (runKey && run.length >= 2) out.push([runKey, run]); };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (skipCity && inCityLocal(mid)) { flush(); run = []; runKey = null; continue; }
    const key = tileOfLocal(mid, z);
    if (key !== runKey) { flush(); run = [a]; runKey = key; }
    run.push(b);
  }
  flush();
  return out;
}

const flat = (pts: Vec2[], round: number) => pts.flatMap((p) => [Math.round(p[0] / round) * round, Math.round(p[1] / round) * round]);

// ---------------------------------------------------------------------------
// Classification

const KEEP_TAGS = /^(building|building:levels|building:min_level|height|min_height|roof:shape|roof:height|roof:levels|roof:colour|building:colour|building:material|amenity|shop|office|tourism|historic|leisure|name|official_name|start_date|wikidata|government|parking|religion|addr:housenumber|addr:street|addr:city|addr:postcode)$/;
const filterTags = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => KEEP_TAGS.test(k)));

const ROAD_KIND: Record<string, RoadKind> = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'trunk', trunk_link: 'trunk', primary: 'primary', primary_link: 'primary',
  secondary: 'secondary', secondary_link: 'secondary', tertiary: 'tertiary', tertiary_link: 'tertiary', residential: 'residential',
  unclassified: 'residential', living_street: 'residential', service: 'service', pedestrian: 'pedestrian',
};
const ROAD_WIDTH: Record<string, number> = { motorway: 15, trunk: 13, primary: 12, secondary: 11, tertiary: 9.5, residential: 7.5, service: 4.5, pedestrian: 5 };
const MAP_LINE: Partial<Record<RoadKind, LineKind>> = { motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary' };

function waterPoly(t: Record<string, string>) {
  return t.natural === 'water' || t.waterway === 'riverbank' || !!t.water || t.landuse === 'reservoir' || t.landuse === 'basin';
}
function greenPoly(t: Record<string, string>): AreaRecord['kind'] | null {
  if (t.leisure === 'park' || t.leisure === 'nature_reserve' || t.leisure === 'golf_course') return 'park';
  if (['grass', 'recreation_ground', 'village_green', 'meadow', 'cemetery'].includes(t.landuse ?? '')) return 'grass';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'grass';
  return null;
}

// Overpass-style elements for the full-detail city build.
const cityElements: unknown[] = [];
const CITY_WAY = (t: Record<string, string>) =>
  !!(t.building || t['building:part'] || t.highway || t.leisure || t.landuse || t.natural || t.waterway || t.railway || t.amenity === 'parking');

const stats = { buildings: 0, lines: 0, polygons: 0, places: 0 };
let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

// ---------------------------------------------------------------------------
// Feature emitters

function emitBuilding(id: string, osm: string, outer: Vec2[], holes: Vec2[][], tags: Record<string, string>) {
  const ring = simplifyRing(cleanRing(outer, 0.15), 0.3);
  if (!ring || polygonArea(ring) < 10) return;
  const fp = ensureCCW(ring).map((p) => [r1(p[0]), r1(p[1])] as Vec2);
  const c = centroid(fp);
  if (inCityLocal(c)) return;
  const rec: BuildingRecord = {
    id, osm, fp, tags: filterTags(tags), front: 0, centroid: [r1(c[0]), r1(c[1])],
    name: tags.name ?? tags.official_name,
    address: tags['addr:housenumber'] && tags['addr:street'] ? `${tags['addr:housenumber']} ${tags['addr:street']}` : undefined,
    street: tags['addr:street'],
  };
  const hs = holes.map((h) => ensureCW(h).map((p) => [r1(p[0]), r1(p[1])] as Vec2)).filter((h) => h.length >= 3);
  if (hs.length) rec.holes = hs;
  spool('detail', tileOfLocal(c, Z.detail), { t: 'b', ...rec });
  stats.buildings++;
}

function emitArea(id: string, kind: 'water' | AreaRecord['kind'], outer: Vec2[], holes: Vec2[][], name?: string) {
  const area = polygonArea(outer);
  if (area < 50) return;
  const c = centroid(outer);
  if (!inCityLocal(c)) {
    const ring = simplifyRing(outer, 1.5);
    if (ring) {
      const rec: AreaRecord = { id, kind: kind as AreaRecord['kind'], name, fp: ring.map((p) => [r1(p[0]), r1(p[1])] as Vec2) };
      if (holes.length) rec.holes = holes.map((h) => (simplifyRing(h, 1.5) ?? h).map((p) => [r1(p[0]), r1(p[1])] as Vec2));
      spool('detail', tileOfLocal(c, Z.detail), { t: 'a', ...rec });
    }
  }
  const pk = kind === 'water' ? 'water' : 'park';
  const levels: [LayerName, number, number][] = kind === 'water' ? [['mid', 20_000, 8], ['overview', 800_000, 60]] : [['mid', 300_000, 20]];
  for (const [layer, minArea, tol] of levels) {
    if (area < minArea) continue;
    const ring = simplifyRing(outer, tol);
    if (!ring || ring.length < 3) continue;
    const f: PolyFeature = { k: pk, p: flat(ring, layer === 'overview' ? 5 : 1) };
    if (name) f.n = name;
    const hs = holes.map((h) => simplifyRing(h, tol)).filter((h): h is Vec2[] => !!h && polygonArea(h) > minArea / 10);
    if (hs.length) f.h = hs.map((h) => flat(h, 1));
    spool(layer, tileOfLocal(c, Z[layer]), { t: 'P', ...f });
  }
  stats.polygons++;
}

function emitLine(kind: LineKind, pts: Vec2[], name: string | undefined, layers: LayerName[]) {
  for (const layer of layers) {
    const tol = layer === 'overview' ? 35 : 6;
    for (const [key, run] of splitByTile(pts, Z[layer], false)) {
      const s = simplifyLine(run, tol);
      if (s.length < 2) continue;
      const f: LineFeature = { k: kind, p: flat(s, layer === 'overview' ? 5 : 1) };
      if (name && layer === 'mid') f.n = name;
      spool(layer, key, { t: 'L', ...f });
    }
  }
  stats.lines++;
}

function emitRoad(id: number, kind: RoadKind, pts: Vec2[], t: Record<string, string>) {
  const lanes = parseFloat(t.lanes);
  const width = parseLength(t.width) ?? (Number.isFinite(lanes) && kind !== 'service' ? Math.max(6, lanes * 3.3 + 1) : ROAD_WIDTH[kind]);
  let n = 0;
  for (const [key, run] of splitByTile(pts, Z.detail, true)) {
    const s = simplifyLine(run, 0.8).map((p) => [r1(p[0]), r1(p[1])] as Vec2);
    const rec: RoadRecord = { id: `osm:w${id}#${n++}`, kind, name: t.name, width: Math.min(width, 30), sidewalk: false, pts: s };
    if (t.oneway === 'yes') rec.oneway = true;
    spool('detail', key, { t: 'r', ...rec });
  }
  const ml = MAP_LINE[kind];
  if (ml) emitLine(ml, pts, t.ref ?? t.name, ['motorway', 'trunk', 'primary'].includes(ml) ? ['mid', 'overview'] : ['mid']);
}

// ---------------------------------------------------------------------------
// Ring assembly from member ways (by node id).

interface MemberWay { refs: number[]; coords: Vec2[] }
const memberWays = new Map<number, MemberWay | null>();

function assemble(ways: MemberWay[]): Vec2[][] {
  const pool = ways.filter((w) => w.refs.length >= 2).map((w) => ({ refs: [...w.refs], coords: [...w.coords] }));
  const rings: Vec2[][] = [];
  while (pool.length) {
    const cur = pool.shift()!;
    let guard = 0;
    while (cur.refs[0] !== cur.refs[cur.refs.length - 1] && guard++ < 2000) {
      const end = cur.refs[cur.refs.length - 1];
      const i = pool.findIndex((w) => w.refs[0] === end || w.refs[w.refs.length - 1] === end);
      if (i < 0) break;
      const nx = pool.splice(i, 1)[0];
      if (nx.refs[0] !== end) { nx.refs.reverse(); nx.coords.reverse(); }
      cur.refs.push(...nx.refs.slice(1));
      cur.coords.push(...nx.coords.slice(1));
    }
    if (cur.refs[0] === cur.refs[cur.refs.length - 1] && cur.coords.length >= 4) rings.push(cur.coords.slice(0, -1));
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Pass 1: relations of interest (and their member ways).

interface RelInfo { id: number; tags: Record<string, string>; members: { ref: number; role: string }[]; kind: 'building' | 'water' | 'green' | 'border' | 'city' }
const relations: RelInfo[] = [];

async function pass1() {
  log(`Pass 1/2: scanning relations in ${path.basename(pbfFile)}…`);
  for await (const item of createOSMStream(pbfFile, { withTags: { node: false, way: false, relation: true }, withInfo: false }) as AsyncGenerator<{
    type: string; id: number; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[];
  }>) {
    if (item.type !== 'relation') continue;
    const t = item.tags ?? {};
    let kind: RelInfo['kind'] | null = null;
    if (t.type === 'multipolygon' && t.building && t.building !== 'no') kind = 'building';
    else if (t.type === 'multipolygon' && waterPoly(t)) kind = 'water';
    else if (t.type === 'multipolygon' && greenPoly(t)) kind = 'green';
    else if (t.type === 'boundary' && t.boundary === 'administrative' && (t.admin_level === '4' || t.admin_level === '6')) kind = 'border';
    else if (t.type === 'multipolygon' && (t['building:part'] || t.leisure)) kind = 'city';
    if (!kind) continue;
    const members = (item.members ?? []).filter((m) => m.type === 'way').map((m) => ({ ref: m.ref, role: m.role }));
    relations.push({ id: item.id, tags: t, members, kind });
    for (const m of members) memberWays.set(m.ref, null);
  }
  log(`  ${relations.length.toLocaleString()} relations, ${memberWays.size.toLocaleString()} member ways`);
}

// ---------------------------------------------------------------------------
// Pass 2: nodes, ways, then relations.

async function pass2() {
  log('Pass 2/2: nodes, ways and relations…');
  let ways = 0, phase = '';
  for await (const item of createOSMStream(pbfFile, { withTags: true, withInfo: false }) as AsyncGenerator<{
    type: string; id: number; lat?: number; lon?: number; refs?: number[]; tags?: Record<string, string>;
    members?: { type: string; ref: number; role: string }[]; osmosis_replication_timestamp?: number;
  }>) {
    if (item.type === 'node') {
      addNode(item.id, item.lat!, item.lon!);
      const t = item.tags;
      if (t) {
        if ((t.place === 'city' || t.place === 'town' || t.place === 'village') && t.name) {
          const p = toLocal(item.lat!, item.lon!);
          const label: PlaceLabel = { n: t.name, k: t.place, p: [Math.round(p[0]), Math.round(p[1])] };
          const pop = parseInt(t.population ?? '', 10);
          if (Number.isFinite(pop)) label.pop = pop;
          spool(t.place === 'village' ? 'mid' : 'overview', tileOfLocal(p, Z[t.place === 'village' ? 'mid' : 'overview']), { t: 'C', ...label });
          stats.places++;
        }
        const g = { lat: item.lat!, lon: item.lon! };
        if ((t.natural === 'tree' || t.historic || t.tourism) && inBox(g.lat, g.lon, cityBox)) cityElements.push({ type: 'node', id: item.id, ...g, tags: t });
        if (t.place && /neighbourhood|quarter|suburb/.test(t.place) && t.name && inBox(g.lat, g.lon, cityPlacesBox)) cityElements.push({ type: 'node', id: item.id, ...g, tags: t });
      }
      if (nodeCount % 5_000_000 === 0) log(`  ${(nodeCount / 1e6).toFixed(0)}M nodes`);
      continue;
    }
    if (item.type === 'way') {
      if (phase !== 'way') { phase = 'way'; log(`  ${nodeCount.toLocaleString()} nodes stored; processing ways…`); }
      ways++;
      if (ways % 1_000_000 === 0) log(`  ${(ways / 1e6).toFixed(0)}M ways, ${stats.buildings.toLocaleString()} buildings`);
      const t = item.tags ?? {};
      const isMember = memberWays.has(item.id);
      const interesting = isMember || t.building || t['building:part'] || t.highway || t.railway || t.waterway || waterPoly(t) || greenPoly(t) || t.leisure || t.landuse || t.natural || t.amenity === 'parking';
      if (!interesting) continue;
      const refs = item.refs ?? [];
      const ll: [number, number][] = [];
      let missing = false;
      for (const r of refs) {
        const n = getNode(r);
        if (!n) { missing = true; break; }
        ll.push(n);
      }
      if (missing || ll.length < 2) continue;
      for (const [lat, lon] of ll) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
      const pts = ll.map(([lat, lon]) => toLocal(lat, lon));
      if (isMember) memberWays.set(item.id, { refs, coords: pts });
      // Raw element for the full-detail city build.
      if (cityBox && CITY_WAY(t) && ll.some(([lat, lon]) => inBox(lat, lon, cityBox))) {
        cityElements.push({ type: 'way', id: item.id, nodes: refs, tags: t, geometry: ll.map(([lat, lon]) => ({ lat, lon })) });
      }
      const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
      const ring = closed ? pts.slice(0, -1) : null;
      if (t.building && t.building !== 'no' && ring) { emitBuilding(`osm:w${item.id}`, `way/${item.id}`, ring, [], t); continue; }
      if (t.highway && ROAD_KIND[t.highway] && t.area !== 'yes' && !['driveway', 'parking_aisle', 'drive-through'].includes(t.service ?? '')) {
        emitRoad(item.id, ROAD_KIND[t.highway], pts, t);
        continue;
      }
      if (t.railway === 'rail' && !t.service) { emitLine('rail', pts, undefined, ['mid']); continue; }
      if (t.waterway === 'river' || t.waterway === 'canal') { emitLine('river', pts, t.name, ['mid', 'overview']); continue; }
      if (t.waterway === 'stream') { emitLine('stream', pts, undefined, ['mid']); continue; }
      if (ring && waterPoly(t)) { emitArea(`osm:w${item.id}`, 'water', ring, [], t.name); continue; }
      const gk = ring ? greenPoly(t) : null;
      if (ring && gk) emitArea(`osm:w${item.id}`, gk, ring, [], t.name);
      continue;
    }
    if (item.type === 'relation') {
      if (phase !== 'relation') {
        phase = 'relation';
        log(`  ${ways.toLocaleString()} ways processed; assembling ${relations.length.toLocaleString()} relations…`);
        processRelations();
      }
    }
  }
  if (phase !== 'relation') processRelations();
}

function processRelations() {
  const emittedBorder = new Set<number>();
  for (const rel of relations) {
    const ways = (role: string) => rel.members.filter((m) => (m.role || 'outer') === role).map((m) => memberWays.get(m.ref)).filter((w): w is MemberWay => !!w);
    if (rel.kind === 'border') {
      const kind: LineKind = rel.tags.admin_level === '4' ? 'state_border' : 'county_border';
      for (const m of rel.members) {
        const w = memberWays.get(m.ref);
        if (!w || emittedBorder.has(m.ref)) continue;
        emittedBorder.add(m.ref);
        emitLine(kind, w.coords, undefined, ['overview', 'mid']);
      }
      continue;
    }
    const outers = assemble(ways('outer'));
    const inners = assemble(ways('inner'));
    if (cityBox && (rel.kind === 'building' || rel.kind === 'city' || rel.kind === 'green')) {
      // Raw multipolygon for the city build when any member touches the city bbox.
      const touches = rel.members.some((m) => {
        const w = memberWays.get(m.ref);
        return w?.coords.some((p) => inCityLocal(p));
      });
      if (touches) {
        cityElements.push({
          type: 'relation', id: rel.id, tags: rel.tags,
          members: rel.members.map((m) => {
            const w = memberWays.get(m.ref);
            return { type: 'way', ref: m.ref, role: m.role, geometry: w ? w.coords.map((p) => { const g = proj.toGeo(p[0], p[1]); return { lat: g.lat, lon: g.lon }; }) : undefined };
          }).filter((m) => m.geometry),
        });
      }
    }
    for (const [i, outer] of outers.entries()) {
      const holes = inners.filter((h) => pointInRing(h[0], outer));
      if (rel.kind === 'building') emitBuilding(`osm:r${rel.id}${i ? `-${i}` : ''}`, `relation/${rel.id}`, outer, holes, rel.tags);
      else if (rel.kind === 'water') emitArea(`osm:r${rel.id}-${i}`, 'water', outer, holes, rel.tags.name);
      else if (rel.kind === 'green') emitArea(`osm:r${rel.id}-${i}`, greenPoly(rel.tags)!, outer, holes, rel.tags.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Finalize: temp files -> gzipped tiles.

const VEHICLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service']);

function frontEdges(buildings: BuildingRecord[], roads: RoadRecord[]) {
  const CELL = 60;
  const grid = new Map<string, { a: Vec2; b: Vec2; name?: string }[]>();
  for (const r of roads) {
    if (!VEHICLE.has(r.kind)) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const k = `${x},${y}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push({ a, b, name: r.name });
        }
    }
  }
  for (const bld of buildings) {
    let best = { score: Infinity, i: 0, street: undefined as string | undefined };
    const fp = bld.fp;
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], b = fp[(i + 1) % fp.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2) continue;
      const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
      const cx = Math.floor(m[0] / CELL), cy = Math.floor(m[1] / CELL);
      let nearest = { d: Infinity, name: undefined as string | undefined, p: m };
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++)
        for (const s of grid.get(`${x},${y}`) ?? []) {
          const c = closestOnSegment(m, s.a, s.b);
          if (c.dist < nearest.d) nearest = { d: c.dist, name: s.name, p: c.point };
        }
      const facing = nearest.d < Infinity ? ((nearest.p[0] - m[0]) * nx + (nearest.p[1] - m[1]) * ny) / (nearest.d || 1) : 0;
      const score = (nearest.d < Infinity ? nearest.d : 200) - facing * 8 - Math.min(len, 30) * 0.3;
      if (score < best.score) best = { score, i, street: nearest.name };
    }
    bld.front = best.i;
    bld.street ??= best.street;
  }
}

function finalize() {
  log('Writing tiles…');
  rmSync(path.join(outDir, 'overview'), { recursive: true, force: true });
  rmSync(path.join(outDir, 'mid'), { recursive: true, force: true });
  rmSync(path.join(outDir, 'detail'), { recursive: true, force: true });
  for (const l of ['overview', 'mid', 'detail'] as LayerName[]) mkdirSync(path.join(outDir, l), { recursive: true });
  let written = 0;
  for (const file of readdirSync(tmpDir)) {
    const [layer, keyFile] = file.split('__') as [LayerName, string];
    const key = keyFile.replace('.ndjson', '');
    const lines = readFileSync(path.join(tmpDir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const strip = <T extends { t?: string }>(o: T) => { delete o.t; return o; };
    let out: unknown;
    if (layer === 'detail') {
      const buildings = lines.filter((l) => l.t === 'b').map(strip) as BuildingRecord[];
      const roads = lines.filter((l) => l.t === 'r').map(strip) as RoadRecord[];
      const areas = lines.filter((l) => l.t === 'a').map(strip) as AreaRecord[];
      frontEdges(buildings, roads);
      const tile: TileData = { key: `${Z.detail}-${key}`, buildings, roads, areas, trees: [] };
      out = tile;
    } else {
      const tile: MapTile = {
        key: `${Z[layer]}-${key}`,
        lines: lines.filter((l) => l.t === 'L').map(strip),
        polys: lines.filter((l) => l.t === 'P').map(strip),
        places: lines.filter((l) => l.t === 'C').map(strip),
      };
      out = tile;
    }
    writeFileSync(path.join(outDir, layer, `${key}.json.gz`), gzipSync(JSON.stringify(out), { level: 6 }));
    if (++written % 2000 === 0) log(`  ${written.toLocaleString()} tiles written`);
  }
  log(`  ${written.toLocaleString()} tiles written`);
}

// ---------------------------------------------------------------------------

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
await pass1();
await pass2();
flushAll();
log(`Features: ${stats.buildings.toLocaleString()} buildings, ${stats.lines.toLocaleString()} lines, ${stats.polygons.toLocaleString()} polygons, ${stats.places.toLocaleString()} places`);
finalize();
rmSync(tmpDir, { recursive: true, force: true });

const [bx0, by0] = proj.toLocal(minLat, minLon);
const [bx1, by1] = proj.toLocal(maxLat, maxLon);
let detailRegion: StateManifest['detailRegion'] = null;
if (city && cityBox) {
  const [cx0, cy0] = proj.toLocal(cityBox[0], cityBox[1]);
  const [cx1, cy1] = proj.toLocal(cityBox[2], cityBox[3]);
  detailRegion = { region: state.detailRegion, bbox: [Math.round(cx0), Math.round(cy0), Math.round(cx1), Math.round(cy1)] };
}
const importedAt = new Date().toISOString();
const manifest: StateManifest = {
  region: stateId,
  name: state.name,
  origin: state.origin,
  bounds: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)],
  attribution: '© OpenStreetMap contributors. Data available under the Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright',
  source: { file: path.basename(pbfFile), importedAt, dataset: 'OpenStreetMap extract (Geofabrik)' },
  detailRegion,
  layers: {
    overview: { z: Z.overview, tiles: [...tileSets.overview].sort() },
    mid: { z: Z.mid, tiles: [...tileSets.mid].sort() },
    detail: { z: Z.detail, tiles: [...tileSets.detail].sort() },
  },
  stats,
};
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(path.join(outDir, 'ATTRIBUTION.md'), `# Data attribution\n\n${manifest.attribution}\n\nSource: ${manifest.source.file}, imported ${importedAt} by scripts/import-state.ts.\n`);

// Raw city data for scripts/build-world.ts (same format as the Overpass download).
if (city && state.detailRegion) {
  writeFileSync(path.join(root, `data/raw/${state.detailRegion}.osm.json`), JSON.stringify({
    attribution: manifest.attribution,
    region: state.detailRegion,
    bbox: city.bbox,
    fetchedAt: importedAt,
    elements: cityElements,
  }));
  log(`Wrote ${cityElements.length.toLocaleString()} raw elements for ${state.detailRegion}; run "npm run data:build" to rebuild it.`);
}
log(`Done: ${manifest.layers.detail.tiles.length.toLocaleString()} detail, ${manifest.layers.mid.tiles.length} mid, ${manifest.layers.overview.tiles.length} overview tiles.`);
