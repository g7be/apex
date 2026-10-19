#!/usr/bin/env node
// One-time OpenStreetMap download for a region. Splits the bbox into a grid of
// small Overpass queries (public instances time out on large ones), retries
// across mirrors, and merges everything into data/raw/<region>.osm.json.
//
// Usage: node scripts/fetch-osm.mjs [regionId]
// Data © OpenStreetMap contributors, ODbL 1.0. Be polite: this runs once, not during gameplay.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const regionId = process.argv[2] ?? 'indianapolis-downtown';
const regions = JSON.parse(await readFile(path.join(root, 'data/regions.json'), 'utf8'));
const region = regions[regionId];
if (!region) throw new Error(`Unknown region ${regionId}`);

const MIRRORS = (process.env.OVERPASS_URLS ?? [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].join(',')).split(',');
const UA = 'IndyPropertySim/0.1 (open-source game prototype; one-time data import)';
const cacheDir = path.join(root, 'data/raw/cache', regionId);
await mkdir(cacheDir, { recursive: true });

const [south, west, north, east] = region.bbox;
const GRID = region.fetchGrid ?? 3;

// Buildings and other features are fetched separately to keep each query small.
const QUERY_GROUPS = {
  buildings: (b) => `way["building"]${b};relation["building"]${b};way["building:part"]${b};relation["building:part"]${b};`,
  features: (b) =>
    `way["highway"]${b};way["leisure"]${b};relation["leisure"]["type"="multipolygon"]${b};way["landuse"]${b};` +
    `way["natural"]${b};way["waterway"]${b};way["amenity"="parking"]${b};way["railway"]${b};` +
    `node["natural"="tree"]${b};node["historic"]${b};node["tourism"]${b};`,
};

function bboxQuery(group, s, w, n, e) {
  return `[out:json][timeout:90];(${QUERY_GROUPS[group](`(${s},${w},${n},${e})`)});out geom;`;
}

function placesQuery() {
  const [s, w, n, e] = region.placesBbox ?? region.bbox;
  return `[out:json][timeout:60];(node["place"~"neighbourhood|quarter|suburb"](${s},${w},${n},${e}););out;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuery(name, query, attempts = 3 * MIRRORS.length) {
  const cacheFile = path.join(cacheDir, `${name}.json`);
  if (existsSync(cacheFile)) return JSON.parse(await readFile(cacheFile, 'utf8'));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(text);
      if (json.remark && /error|timeout/i.test(json.remark)) throw new Error(json.remark);
      await writeFile(cacheFile, text);
      console.log(`  ✓ ${name} from ${new URL(url).host}: ${json.elements.length} elements`);
      return json;
    } catch (err) {
      console.warn(`  ✗ ${name} via ${new URL(url).host}: ${err.message}`);
      await sleep(Math.min(30_000, 2000 + attempt * 3000));
    }
  }
  throw new Error(`All Overpass mirrors failed for ${name}`);
}

console.log(`Fetching ${region.name} in a ${GRID}x${GRID} grid…`);
const byKey = new Map();
const add = (els) => { for (const el of els) byKey.set(`${el.type}/${el.id}`, el); };
// A cell that keeps timing out is split into four smaller cells (up to 2 levels).
async function fetchCell(group, name, s, w, n, e, depth = 0) {
  const q = bboxQuery(group, s.toFixed(5), w.toFixed(5), n.toFixed(5), e.toFixed(5));
  try {
    add((await runQuery(name, q, depth < 2 ? Math.max(2, MIRRORS.length) : 8 * MIRRORS.length)).elements);
    await sleep(1000);
  } catch (err) {
    if (depth >= 2) throw err;
    console.log(`  ↳ splitting ${name}`);
    const ms = (s + n) / 2, mw = (w + e) / 2;
    await fetchCell(group, `${name}.0`, s, w, ms, mw, depth + 1);
    await fetchCell(group, `${name}.1`, s, mw, ms, e, depth + 1);
    await fetchCell(group, `${name}.2`, ms, w, n, mw, depth + 1);
    await fetchCell(group, `${name}.3`, ms, mw, n, e, depth + 1);
  }
}

const dLat = (north - south) / GRID, dLon = (east - west) / GRID;
for (let i = 0; i < GRID; i++) {
  for (let j = 0; j < GRID; j++) {
    const s = south + i * dLat, w = west + j * dLon;
    for (const group of Object.keys(QUERY_GROUPS)) {
      await fetchCell(group, `${group}-${i}-${j}`, s, w, s + dLat, w + dLon);
    }
  }
}
add((await runQuery('places', placesQuery())).elements);

const out = {
  attribution: '© OpenStreetMap contributors. Data available under the Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright',
  region: regionId,
  bbox: region.bbox,
  fetchedAt: new Date().toISOString(),
  elements: [...byKey.values()],
};
await writeFile(path.join(root, `data/raw/${regionId}.osm.json`), JSON.stringify(out));
console.log(`Saved ${out.elements.length} unique elements to data/raw/${regionId}.osm.json`);
