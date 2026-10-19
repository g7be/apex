// Geographic projection and tiling.
//
// Each region has a fixed origin. Positions inside a region use a local
// tangent-plane frame in meters: x = east, y = north. (The 3D client maps this
// to three.js as (x, height, -y).) At city scale the equirectangular
// approximation below is accurate to a few centimeters, and it is stable:
// the same lat/lon always yields the same local coordinates.
//
// Tiles use the global Web-Mercator slippy scheme (z/x/y), so tile keys are
// globally unique and a future world server can shard by tile range.

export const EARTH_RADIUS = 6_378_137;
const DEG = Math.PI / 180;

export interface GeoOrigin { lat: number; lon: number }
export type Vec2 = [number, number];

export function createProjection(origin: GeoOrigin) {
  const cosLat = Math.cos(origin.lat * DEG);
  return {
    origin,
    toLocal(lat: number, lon: number): Vec2 {
      return [
        (lon - origin.lon) * DEG * EARTH_RADIUS * cosLat,
        (lat - origin.lat) * DEG * EARTH_RADIUS,
      ];
    },
    toGeo(x: number, y: number): { lat: number; lon: number } {
      return {
        lat: origin.lat + y / (EARTH_RADIUS * DEG),
        lon: origin.lon + x / (EARTH_RADIUS * DEG * cosLat),
      };
    },
  };
}
export type Projection = ReturnType<typeof createProjection>;

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = lat * DEG;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

export function tileToLonLatBounds(x: number, y: number, z: number) {
  const n = 2 ** z;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) / DEG;
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
}

export const tileKey = (z: number, x: number, y: number) => `${z}-${x}-${y}`;
