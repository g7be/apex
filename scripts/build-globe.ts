// Builds the globe's land masses from Natural Earth (public domain) into a
// compact file the client rasterizes into the globe texture.
//
// Usage: npx tsx scripts/build-globe.ts
// Input:  data/raw/naturalearth/ne_50m_land.geojson, ne_50m_lakes.geojson
//         (https://github.com/nvkelso/natural-earth-vector)
// Output: data/world/globe/landmasses.json  { land: number[][], lakes: number[][] }
//         Each ring is a flat [lon, lat, lon, lat, …] array in degrees.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simplifyLine, type Vec2 } from '@indy/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'data/raw/naturalearth');

type Geom = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

function rings(file: string, tolerance: number): number[][] {
  const fc = JSON.parse(readFileSync(path.join(src, file), 'utf8')) as { features: { geometry: Geom }[] };
  const out: number[][] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      // Outer ring only: holes inside land are lakes, which come from the lakes file.
      const ring = poly[0].map((p) => [p[0], p[1]] as Vec2);
      const s = simplifyLine(ring, tolerance);
      if (s.length < 4) continue;
      out.push(s.flatMap((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]));
    }
  }
  return out;
}

const land = rings('ne_50m_land.geojson', 0.04);
const lakes = rings('ne_50m_lakes.geojson', 0.03);

// Country labels: name, label point and Natural Earth's minimum label zoom
// (lower = shown from further away).
interface CountryProps { NAME: string; LABEL_X: number; LABEL_Y: number; MIN_LABEL: number; LABELRANK: number; POP_EST: number }
const countriesFc = JSON.parse(readFileSync(path.join(src, 'ne_50m_admin_0_countries.geojson'), 'utf8')) as { features: { properties: CountryProps }[] };
const countries = countriesFc.features
  .map(({ properties: p }) => ({
    n: p.NAME,
    lon: Math.round(p.LABEL_X * 100) / 100,
    lat: Math.round(p.LABEL_Y * 100) / 100,
    min: p.MIN_LABEL,
    rank: p.LABELRANK,
    pop: p.POP_EST,
  }))
  .sort((a, b) => a.min - b.min || a.rank - b.rank || b.pop - a.pop);
// Border lines (country and state/province), simplified, as flat lon/lat arrays.
type LineGeom = { type: 'LineString'; coordinates: number[][] } | { type: 'MultiLineString'; coordinates: number[][][] };
function lines(file: string, tolerance: number): number[][] {
  const fc = JSON.parse(readFileSync(path.join(src, file), 'utf8')) as { features: { geometry: LineGeom }[] };
  const out: number[][] = [];
  for (const f of fc.features) {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const part of parts) {
      const s = simplifyLine(part.map((p) => [p[0], p[1]] as Vec2), tolerance);
      if (s.length >= 2) out.push(s.flatMap((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]));
    }
  }
  return out;
}
const countryBorders = lines('ne_50m_admin_0_boundary_lines_land.geojson', 0.02);
const stateBorders = lines('ne_50m_admin_1_states_provinces_lines.geojson', 0.02);

// State/province labels (US states plus first-level divisions of a few large countries).
interface StateProps { name: string; latitude: number; longitude: number; min_label: number; labelrank: number; admin: string }
const statesFc = JSON.parse(readFileSync(path.join(src, 'ne_50m_admin_1_states_provinces.geojson'), 'utf8')) as { features: { properties: StateProps }[] };
const states = statesFc.features
  .map(({ properties: p }) => ({
    n: p.name,
    lon: Math.round(p.longitude * 100) / 100,
    lat: Math.round(p.latitude * 100) / 100,
    min: p.min_label,
    rank: p.labelrank,
    c: p.admin,
  }))
  .sort((a, b) => a.min - b.min || a.rank - b.rank);

mkdirSync(path.join(root, 'data/world/globe'), { recursive: true });
const outFile = path.join(root, 'data/world/globe/landmasses.json');
writeFileSync(outFile, JSON.stringify({
  attribution: 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com (public domain).',
  land,
  lakes,
  countries,
  states,
  countryBorders,
  stateBorders,
}));
console.log(`Globe: ${land.length} land rings, ${lakes.length} lakes, ${countries.length} countries, ${states.length} states, ${countryBorders.length}+${stateBorders.length} border lines → ${path.relative(root, outFile)} (${(readFileSync(outFile).length / 1024).toFixed(0)} KB)`);
