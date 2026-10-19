// State-scale world data (e.g. all of Indiana), produced by scripts/import-state.ts.
//
// Three levels of detail, each a set of global Web-Mercator tiles:
//   overview (z9)  – highways, rivers, big lakes, state/county borders, town labels
//   mid      (z12) – + secondary/tertiary roads, railways, smaller water
//   detail   (z14) – simplified building footprints (TileData format), local roads, parks
// The high-detail city region (data/world/<detailRegion>) covers its own bbox;
// state tiles exclude that area so nothing is drawn twice.
// All coordinates use the same local frame (x east, y north, meters) as the
// city region, because both share one origin.
import type { GeoOrigin } from './geo.ts';

export type StateLayerName = 'overview' | 'mid' | 'detail';

export interface StateLayerInfo {
  z: number;
  /** Tile keys "x-y" that exist for this layer. */
  tiles: string[];
}

export interface StateManifest {
  region: string;
  name: string;
  origin: GeoOrigin;
  /** Local-meter bounds [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  attribution: string;
  source: { file: string; importedAt: string; dataset: string };
  /** City region with full detail that state tiles leave out. */
  detailRegion: { region: string; bbox: [number, number, number, number] } | null;
  layers: Record<StateLayerName, StateLayerInfo>;
  stats: { buildings: number; lines: number; polygons: number; places: number };
}

export type LineKind =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'rail' | 'river' | 'stream'
  | 'state_border' | 'county_border';

export type PolyKind = 'water' | 'park' | 'forest';

/** Polyline as a flat [x0, y0, x1, y1, …] array in local meters. */
export interface LineFeature { k: LineKind; n?: string; p: number[] }
export interface PolyFeature { k: PolyKind; n?: string; p: number[]; h?: number[][] }
export interface PlaceLabel { n: string; k: 'city' | 'town' | 'village'; p: [number, number]; pop?: number }

/** Tile for the overview and mid layers. */
export interface MapTile {
  key: string;
  lines: LineFeature[];
  polys: PolyFeature[];
  places: PlaceLabel[];
}
