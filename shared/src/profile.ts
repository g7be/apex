// Deterministic building profile: classification, floors, height, roof, facade
// style and virtual rent. Uses real OSM tags whenever present and seeded
// defaults otherwise. Client and server share this code, so the price the
// server charges is exactly the price the client displays.
import type { BuildingRecord, BuildingPart } from './types.ts';
import { polygonArea, rectangularity } from './geometry.ts';
import { hashString, createRng } from './rng.ts';

export const PROFILE_VERSION = 1;

export type BuildingClass =
  | 'office' | 'retail' | 'residential' | 'house' | 'mixed' | 'hotel' | 'civic' | 'education'
  | 'religious' | 'parking' | 'industrial' | 'venue' | 'landmark' | 'structure';

export const CLASS_LABELS: Record<BuildingClass, string> = {
  office: 'Office', retail: 'Retail / Commercial', residential: 'Residential', house: 'House',
  mixed: 'Mixed Use', hotel: 'Hotel', civic: 'Civic / Government', education: 'Education',
  religious: 'Religious', parking: 'Parking Garage', industrial: 'Industrial / Warehouse',
  venue: 'Venue / Arena', landmark: 'Landmark', structure: 'Structure',
};

export type FacadeStyle = 'glass' | 'concrete' | 'brick' | 'limestone' | 'residential' | 'industrial' | 'parking' | 'historic';
export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome';

export interface BuildingProfile {
  id: string;
  seed: number;
  cls: BuildingClass;
  clsLabel: string;
  floors: number;
  floorHeight: number;
  height: number;
  minHeight: number;
  roofShape: RoofShape;
  roofHeight: number;
  footprintArea: number;
  grossFloorArea: number;
  style: FacadeStyle;
  wallColor: string;
  roofColor: string;
  /** Fraction of each facade bay that is window (0–1). */
  windowRatio: number;
  /** Ground floor rendered as a storefront. */
  storefront: boolean;
  heightSource: 'osm:height' | 'osm:levels' | 'osm:parts' | 'estimated';
  displayName: string;
  /** Can be leased by players. */
  rentable: boolean;
  /** Has collision for player movement. */
  solid: boolean;
  monthlyRent: number;
  yearBuilt?: string;
}

const RESIDENTIAL = new Set(['apartments', 'residential', 'dormitory', 'flats']);
const HOUSE = new Set(['house', 'detached', 'terrace', 'semidetached_house', 'bungalow', 'townhouse']);
const RETAIL = new Set(['retail', 'supermarket', 'kiosk', 'shop', 'store']);
const CIVIC = new Set(['government', 'civic', 'public', 'courthouse', 'fire_station', 'townhall', 'train_station',
  'transportation', 'hospital', 'museum', 'library', 'police']);
const RELIGIOUS = new Set(['church', 'cathedral', 'chapel', 'religious', 'mosque', 'synagogue', 'temple']);
const EDUCATION = new Set(['school', 'university', 'college', 'kindergarten']);
const PARKING = new Set(['parking', 'garage', 'garages', 'carport']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'manufacture', 'service', 'storage_tank']);
const VENUE = new Set(['stadium', 'sports_centre', 'sports_hall', 'grandstand', 'arena']);
const STRUCTURE = new Set(['roof', 'canopy', 'construction', 'ruins', 'bridge', 'shed', 'hut', 'kiosk_canopy', 'tower', 'toilets']);

const FLOOR_HEIGHT: Record<BuildingClass, number> = {
  office: 3.9, retail: 4.4, residential: 3.1, house: 3.0, mixed: 3.6, hotel: 3.3, civic: 4.5, education: 4.0,
  religious: 9, parking: 3.1, industrial: 5.5, venue: 9, landmark: 6, structure: 4,
};

/** Parse OSM length values like "45", "45 m", "150'", "12'6\"". */
export function parseLength(v?: string): number | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(',', '.');
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/i);
  if (ft) return +ft[1] * 0.3048 + (ft[2] ? +ft[2] * 0.0254 : 0);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/i);
  return m ? +m[1] : undefined;
}

const parseIntTag = (v?: string) => {
  if (!v) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n < 200 ? n : undefined;
};

const NAMED_COLORS: Record<string, string> = {
  white: '#f2f0ea', black: '#2a2a2a', grey: '#8d8d8d', gray: '#8d8d8d', darkgrey: '#5b5b5b', darkgray: '#5b5b5b',
  lightgrey: '#c8c8c8', lightgray: '#c8c8c8', silver: '#c0c4c8', red: '#a3412f', darkred: '#6e2a22', brown: '#7a5638',
  tan: '#cbb08a', beige: '#dccfb2', yellow: '#d9c36a', green: '#5d7f58', darkgreen: '#3d5a3a', blue: '#5c7894',
  lightblue: '#9fb9cf', navy: '#2e3f5a', orange: '#c9773b', maroon: '#6b2b2b', cream: '#efe6cf', ivory: '#f0ead8',
  sandybrown: '#d29a62', sienna: '#9a5a3a', teal: '#3f7f7f', olive: '#7a7a45', gold: '#c8a54a', copper: '#8f5a3a',
};

export function parseColour(v?: string): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  return NAMED_COLORS[s];
}

const STYLE_PALETTES: Record<FacadeStyle, string[]> = {
  glass: ['#7f97ab', '#6f8796', '#8ea3b3', '#5f7486', '#9aa9b2'],
  concrete: ['#b9b4aa', '#a8a39a', '#c4c0b6', '#9c978d'],
  brick: ['#8e4e3a', '#9c5a40', '#7d4433', '#a8694c', '#86513e'],
  limestone: ['#d8ccb2', '#cfc2a5', '#e0d6bf', '#c7b999'],
  residential: ['#c9b79c', '#b8a68a', '#a86f58', '#d3c7b2', '#8f6a55'],
  industrial: ['#9a958b', '#8b8f91', '#a19a8a'],
  parking: ['#b3afa6', '#a6a29a'],
  historic: ['#c9b48f', '#b9a07a', '#a37d5c'],
};

function classify(b: BuildingRecord, floorsHint: number | undefined, area: number, rng: () => number): BuildingClass {
  const t = b.tags;
  const bt = (t.building ?? 'yes').toLowerCase();
  if (t.historic === 'monument' || t.historic === 'memorial' || bt === 'monument') return 'landmark';
  if (t.tourism === 'hotel' || bt === 'hotel') return 'hotel';
  if (STRUCTURE.has(bt)) return 'structure';
  if (PARKING.has(bt) || t.amenity === 'parking' || t.parking === 'multi-storey') return 'parking';
  if (VENUE.has(bt) || t.leisure === 'stadium' || t.leisure === 'sports_centre') return 'venue';
  if (RELIGIOUS.has(bt) || t.amenity === 'place_of_worship') return 'religious';
  if (EDUCATION.has(bt) || ['school', 'university', 'college'].includes(t.amenity ?? '')) return 'education';
  if (CIVIC.has(bt) || ['townhall', 'courthouse', 'library', 'police', 'fire_station', 'hospital'].includes(t.amenity ?? '')
    || ['museum', 'gallery'].includes(t.tourism ?? '') || t.government) return 'civic';
  if (HOUSE.has(bt)) return area > 400 ? 'residential' : 'house';
  if (RESIDENTIAL.has(bt)) return t.shop || t.amenity ? 'mixed' : 'residential';
  if (INDUSTRIAL.has(bt)) return 'industrial';
  if (bt === 'office') return 'office';
  if (RETAIL.has(bt)) return 'retail';
  if (bt === 'commercial') return t.office || (floorsHint ?? 0) >= 5 ? 'office' : 'retail';
  if (t.office) return 'office';
  if (t.shop || ['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'bank', 'cinema', 'theatre', 'nightclub'].includes(t.amenity ?? '')) return 'retail';
  // Untyped building ("building=yes"): choose by size, deterministically.
  const f = floorsHint ?? 0;
  if (f >= 8 || area > 4000) return 'office';
  if (area < 160) return 'retail';
  const r = rng();
  if (f >= 4) return r < 0.6 ? 'office' : r < 0.85 ? 'mixed' : 'residential';
  return r < 0.4 ? 'retail' : r < 0.7 ? 'mixed' : 'office';
}

function estimateFloors(cls: BuildingClass, area: number, rng: ReturnType<typeof createRng>): number {
  switch (cls) {
    case 'house': return rng.int(1, 2) + (area > 120 ? 1 : 0);
    case 'residential': return area < 300 ? rng.int(2, 3) : rng.int(3, 6);
    case 'retail': return area < 250 ? rng.int(1, 2) : rng.int(1, 3);
    case 'mixed': return rng.int(2, 5);
    case 'office': return area < 500 ? rng.int(2, 4) : area < 2000 ? rng.int(4, 10) : rng.int(6, 16);
    case 'hotel': return rng.int(5, 14);
    case 'parking': return rng.int(4, 7);
    case 'civic': case 'education': return rng.int(2, 4);
    case 'industrial': return rng.int(1, 2);
    case 'religious': case 'venue': case 'landmark': return 1;
    case 'structure': return 1;
  }
}

/** Effective vertical extent of a building with parts. */
function partsExtent(parts: BuildingPart[]): { height: number; levels?: number } {
  let height = 0, levels: number | undefined;
  for (const p of parts) {
    const h = p.height ?? (p.levels != null ? p.levels * 3.5 : undefined);
    if (h != null && h > height) height = h;
    if (p.levels != null) levels = Math.max(levels ?? 0, p.levels);
  }
  return { height, levels };
}

/** Deterministic monthly rent in virtual currency. Not a real-world estimate. */
export function computeMonthlyRent(cls: BuildingClass, grossFloorArea: number, centroid: [number, number], landmark: boolean): number {
  const CLASS_FACTOR: Record<BuildingClass, number> = {
    retail: 1.1, office: 1.0, residential: 0.85, house: 0.8, mixed: 1.0, hotel: 1.2, civic: 1.3, education: 0.9,
    religious: 0.9, parking: 0.6, industrial: 0.7, venue: 1.5, landmark: 2.0, structure: 0.5,
  };
  const dist = Math.hypot(centroid[0], centroid[1]);
  const location = 0.8 + 0.6 * Math.exp(-dist / 600);
  const raw = 290 * Math.pow(Math.max(grossFloorArea, 20) / 100, 0.8) * CLASS_FACTOR[cls] * location * (landmark ? 1.5 : 1);
  return Math.max(250, Math.round(raw / 50) * 50);
}

export function buildingDisplayName(b: BuildingRecord): string {
  if (b.name) return b.name;
  if (b.address) return b.address;
  if (b.street) return `Building on ${b.street}`;
  return 'Unnamed building';
}

const profileCache = new Map<string, BuildingProfile>();

export function deriveProfile(b: BuildingRecord): BuildingProfile {
  const cached = profileCache.get(b.id);
  if (cached) return cached;
  const seed = hashString(`${b.id}:profile:v${PROFILE_VERSION}`);
  const rng = createRng(seed);
  const t = b.tags;
  const area = polygonArea(b.fp) - (b.holes ?? []).reduce((s, h) => s + polygonArea(h), 0);

  let levels = parseIntTag(t['building:levels']);
  let height = parseLength(t.height);
  let heightSource: BuildingProfile['heightSource'] = height != null ? 'osm:height' : levels != null ? 'osm:levels' : 'estimated';
  if (b.parts?.length && height == null) {
    const pe = partsExtent(b.parts);
    if (pe.height > 0) { height = pe.height; heightSource = 'osm:parts'; }
    levels ??= pe.levels;
  }
  const minHeight = parseLength(t.min_height) ?? (parseIntTag(t['building:min_level']) ?? 0) * 3.5;

  const cls = classify(b, levels ?? (height != null ? height / 3.5 : undefined), area, rng.next);
  const floorHeightBase = FLOOR_HEIGHT[cls];
  let floors: number;
  if (levels != null && levels >= 1) floors = Math.round(levels);
  else if (height != null) floors = Math.max(1, Math.round((height - minHeight) / floorHeightBase));
  else floors = estimateFloors(cls, area, rng);
  floors = Math.max(1, Math.min(floors, 120));

  let floorHeight = floorHeightBase;
  if (height == null) height = minHeight + floors * floorHeight;
  else floorHeight = Math.max(2.4, Math.min(12, (height - minHeight) / floors));

  const rect = rectangularity(b.fp);
  const tagRoof = (t['roof:shape'] ?? '').toLowerCase();
  let roofShape: RoofShape = 'flat';
  if (['gabled', 'saltbox', 'gambrel', 'mansard'].includes(tagRoof)) roofShape = 'gabled';
  else if (['hipped', 'half-hipped'].includes(tagRoof)) roofShape = 'hipped';
  else if (tagRoof === 'pyramidal') roofShape = 'pyramidal';
  else if (['dome', 'onion', 'round'].includes(tagRoof)) roofShape = 'dome';
  else if (!tagRoof && (cls === 'house' || (cls === 'residential' && floors <= 3 && area < 350) || cls === 'religious') && rect > 0.85 && b.fp.length <= 8) {
    roofShape = rng.chance(0.6) ? 'gabled' : 'hipped';
  }
  if ((roofShape === 'gabled' || roofShape === 'hipped') && rect < 0.8) roofShape = rect > 0.6 ? 'pyramidal' : 'flat';
  const roofHeight = roofShape === 'flat' ? 0
    : parseLength(t['roof:height']) ?? Math.min(8, Math.sqrt(area) * (roofShape === 'dome' ? 0.35 : 0.22));

  let style: FacadeStyle;
  const material = (t['building:material'] ?? '').toLowerCase();
  if (material === 'brick') style = 'brick';
  else if (material === 'glass') style = 'glass';
  else if (['stone', 'limestone', 'sandstone', 'marble'].includes(material)) style = 'limestone';
  else if (material === 'concrete') style = 'concrete';
  else if (cls === 'parking') style = 'parking';
  else if (cls === 'industrial') style = 'industrial';
  else if (cls === 'house' || cls === 'residential') style = rng.chance(0.55) ? 'brick' : 'residential';
  else if (cls === 'landmark' || cls === 'religious' || cls === 'civic') style = rng.chance(0.7) ? 'limestone' : 'historic';
  else if (cls === 'office' || cls === 'hotel') style = floors >= 10 ? (rng.chance(0.7) ? 'glass' : 'concrete') : rng.pick(['brick', 'concrete', 'glass', 'limestone'] as const);
  else style = rng.pick(['brick', 'brick', 'historic', 'concrete', 'limestone'] as const);

  const palette = STYLE_PALETTES[style];
  const wallColor = parseColour(t['building:colour']) ?? palette[Math.floor(rng.next() * palette.length)];
  const roofColor = parseColour(t['roof:colour'])
    ?? (roofShape === 'flat' ? rng.pick(['#6d6b66', '#7b7873', '#5f5d59', '#8a867e']) : rng.pick(['#5b4134', '#4a4a4f', '#6a3b30', '#3f4448']));
  const windowRatio = style === 'glass' ? 0.92 : style === 'parking' ? 1 : style === 'industrial' ? 0.3 : rng.range(0.42, 0.62);
  const storefront = (cls === 'retail' || cls === 'mixed' || (cls === 'office' && rng.chance(0.4)) || cls === 'hotel') && floors >= 1 && style !== 'parking';

  const grossFloorArea = Math.round(area * floors);
  const landmark = cls === 'landmark' || !!t.historic || !!t.wikidata;
  const rentable = cls !== 'structure' && area >= 15;
  const profile: BuildingProfile = {
    id: b.id,
    seed,
    cls,
    clsLabel: CLASS_LABELS[cls],
    floors,
    floorHeight,
    height,
    minHeight,
    roofShape,
    roofHeight,
    footprintArea: Math.round(area),
    grossFloorArea,
    style,
    wallColor,
    roofColor,
    windowRatio,
    storefront,
    heightSource,
    displayName: buildingDisplayName(b),
    rentable,
    solid: cls !== 'structure' || (t.building !== 'roof' && t.building !== 'canopy'),
    monthlyRent: computeMonthlyRent(cls, grossFloorArea, b.centroid, landmark),
    yearBuilt: t.start_date,
  };
  profileCache.set(b.id, profile);
  return profile;
}
