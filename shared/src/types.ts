// Static world data format produced by scripts/build-world.ts.
// Static geography lives in data/world/<region>/ and is never modified at
// runtime; player-modified state (leases, balances) lives in the server DB.
import type { GeoOrigin, Vec2 } from './geo.ts';

export interface BuildingPart {
  /** Outer ring in local meters (x east, y north), counter-clockwise. */
  fp: Vec2[];
  holes?: Vec2[][];
  height?: number;
  minHeight?: number;
  levels?: number;
  minLevel?: number;
  roofShape?: string;
  roofHeight?: number;
  colour?: string;
  roofColour?: string;
}

export interface BuildingRecord {
  /** Stable global id derived from the OSM element: "osm:w123" / "osm:r456". */
  id: string;
  /** OSM element reference, e.g. "way/123". */
  osm: string;
  fp: Vec2[];
  holes?: Vec2[][];
  /** Raw-ish OSM tags we care about (already filtered). */
  tags: Record<string, string>;
  name?: string;
  address?: string;
  /** Index of the footprint edge facing the nearest street (entrance side). */
  front: number;
  /** Name of the nearest street, when known. */
  street?: string;
  centroid: Vec2;
  /** 3D parts (building:part) that replace the outline when rendering. */
  parts?: BuildingPart[];
}

export type RoadKind =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential'
  | 'service' | 'pedestrian' | 'footway' | 'cycleway' | 'steps' | 'rail';

export interface RoadRecord {
  id: string;
  kind: RoadKind;
  name?: string;
  width: number;
  /** Has sidewalks rendered along both sides. */
  sidewalk: boolean;
  oneway?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
  pts: Vec2[];
}

export type AreaKind = 'park' | 'grass' | 'water' | 'parking' | 'plaza' | 'pitch' | 'garden';

export interface AreaRecord {
  id: string;
  kind: AreaKind;
  name?: string;
  fp: Vec2[];
  holes?: Vec2[][];
}

export interface TileData {
  key: string;
  buildings: BuildingRecord[];
  roads: RoadRecord[];
  areas: AreaRecord[];
  trees: Vec2[];
}

export interface TileInfo {
  key: string;
  z: number;
  x: number;
  y: number;
  /** Local-meter bounds [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  buildings: number;
  file: string;
}

export interface Neighborhood { name: string; pos: Vec2 }
export interface Landmark { name: string; pos: Vec2; kind: string }

export interface WorldManifest {
  region: string;
  name: string;
  origin: GeoOrigin;
  tileZoom: number;
  bounds: [number, number, number, number];
  attribution: string;
  source: { fetchedAt: string; dataset: string };
  generatorVersion: number;
  tiles: TileInfo[];
  neighborhoods: Neighborhood[];
  landmarks: Landmark[];
  spawn: Vec2;
  stats: { buildings: number; roads: number; areas: number; trees: number };
}
