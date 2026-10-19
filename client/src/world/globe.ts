// Real-scale Earth. The world's local frame is a plane tangent to the Earth at
// the region origin (Monument Circle): x east, y up, z = -north. The globe is
// a sphere of Earth's radius whose surface touches that plane at the origin,
// so the flat street-level map and the globe line up exactly where they meet.
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EARTH_RADIUS, createProjection, type GeoOrigin } from '@indy/shared';

export const R = EARTH_RADIUS;
/** Earth's center in three.js coordinates. */
export const EARTH_CENTER = new THREE.Vector3(0, -R, 0);

/** Ground color shared by the flat map and the globe's land. */
export const GROUND_GREEN = '#5a8a46';
export const OCEAN_BLUE = '#2b6aa3';

const DEG = Math.PI / 180;
let origin: GeoOrigin = { lat: 39.7684, lon: -86.1581 };
let proj = createProjection(origin);
let basis = makeBasis(origin);

function makeBasis(o: GeoOrigin) {
  const p0 = o.lat * DEG, l0 = o.lon * DEG;
  return { sp: Math.sin(p0), cp: Math.cos(p0), sl: Math.sin(l0), cl: Math.cos(l0) };
}

export function setGlobeOrigin(o: GeoOrigin) {
  origin = o;
  proj = createProjection(o);
  basis = makeBasis(o);
}

/** Point on the sphere (lat/lon degrees, altitude meters) in three.js coordinates. */
export function globePoint(lat: number, lon: number, h = 0, out = new THREE.Vector3()) {
  const p = lat * DEG, l = lon * DEG;
  const X = Math.cos(p) * Math.cos(l), Y = Math.cos(p) * Math.sin(l), Z = Math.sin(p);
  const { sp, cp, sl, cl } = basis;
  const e = -sl * X + cl * Y;
  const n = -sp * cl * X - sp * sl * Y + cp * Z;
  const u = cp * cl * X + cp * sl * Y + sp * Z;
  const r = R + h;
  return out.set(e * r, u * r - R, -n * r);
}

/** Region-local flat coordinates ↔ geographic coordinates. */
export const flatToGeo = (x: number, yNorth: number) => proj.toGeo(x, yNorth);
export const geoToFlat = (lat: number, lon: number) => proj.toLocal(lat, lon);

/** Ground point + local east/north/up axes at a flat focus point, on the sphere. */
export function focusFrame(x: number, yNorth: number) {
  const g = proj.toGeo(x, yNorth);
  const lat = THREE.MathUtils.clamp(g.lat, -89, 89);
  const point = globePoint(lat, g.lon, 0);
  const up = point.clone().sub(EARTH_CENTER).normalize();
  const north = globePoint(lat + 0.01, g.lon, 0).sub(point);
  north.addScaledVector(up, -north.dot(up)).normalize();
  const east = new THREE.Vector3().crossVectors(north, up).normalize();
  return { lat, lon: g.lon, point, up, north, east };
}

/** Region-local (x east, y north, meters) → point on the sphere. */
export function flatToGlobe(x: number, yNorth: number, h = 0, out = new THREE.Vector3()) {
  const g = proj.toGeo(x, yNorth);
  return globePoint(g.lat, g.lon, h, out);
}

// --- texture ------------------------------------------------------------------

export interface CountryLabel { n: string; lon: number; lat: number; min: number; rank: number; pop: number }
export interface StateLabel { n: string; lon: number; lat: number; min: number; rank: number; c: string }
interface Landmasses {
  land: number[][];
  lakes: number[][];
  countries?: CountryLabel[];
  states?: StateLabel[];
  countryBorders?: number[][];
  stateBorders?: number[][];
}

function paintTexture(data: Landmasses | null): THREE.CanvasTexture {
  const W = 4096, H = 2048;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = OCEAN_BLUE;
  ctx.fillRect(0, 0, W, H);
  const X = (lon: number) => ((lon + 180) / 360) * W;
  const Y = (lat: number) => ((90 - lat) / 180) * H;
  const fill = (rings: number[][], color: string) => {
    ctx.fillStyle = color;
    for (const r of rings) {
      ctx.beginPath();
      for (let i = 0; i < r.length; i += 2) {
        if (i) ctx.lineTo(X(r[i]), Y(r[i + 1]));
        else ctx.moveTo(X(r[i]), Y(r[i + 1]));
      }
      ctx.closePath();
      ctx.fill();
    }
  };
  if (data) {
    fill(data.land, GROUND_GREEN);
    fill(data.lakes, OCEAN_BLUE);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// --- meshes -------------------------------------------------------------------

/** Sphere built from a lat/lon grid so the equirectangular texture maps exactly. */
function sphereGeometry(segLon: number, segLat: number, h: number) {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  const v = new THREE.Vector3();
  for (let j = 0; j <= segLat; j++) {
    const lat = -90 + (180 * j) / segLat;
    for (let i = 0; i <= segLon; i++) {
      const lon = -180 + (360 * i) / segLon;
      globePoint(lat, lon, h, v);
      pos.push(v.x, v.y, v.z);
      const n = v.clone().sub(EARTH_CENTER).normalize();
      nrm.push(n.x, n.y, n.z);
      uv.push(i / segLon, j / segLat);
    }
  }
  for (let j = 0; j < segLat; j++)
    for (let i = 0; i < segLon; i++) {
      const a = j * (segLon + 1) + i, b = a + 1, c = a + segLon + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function atmosphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { center: { value: EARTH_CENTER } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 view = normalize(cameraPosition - vWorld);
        float rim = 1.0 - abs(dot(view, normalize(vNormal)));
        float a = pow(rim, 3.0) * 0.9;
        gl_FragColor = vec4(vec3(0.45, 0.7, 1.0), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
}

function makeStars() {
  const n = 2500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Uniform directions on a unit sphere; scaled around the camera each frame.
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(t), u, s * Math.sin(t)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

// --- borders --------------------------------------------------------------------

/** Camera distance below which the globe's borders give way to the detailed state map. */
const BORDERS_MIN_CAM = 200_000;
const borderMats = {
  country: new LineMaterial({ color: '#0b0c0e', linewidth: 1.6, worldUnits: false, transparent: true, opacity: 0.9, depthWrite: false }),
  state: new LineMaterial({ color: '#141518', linewidth: 1.0, worldUnits: false, transparent: true, opacity: 0.75, depthWrite: false }),
};
const borders = new THREE.Group();
borders.name = 'borders';

export function setGlobeLineResolution(w: number, h: number) {
  borderMats.country.resolution.set(w, h);
  borderMats.state.resolution.set(w, h);
}

/**
 * Border polylines on the sphere. Long straight segments (like the US–Canada
 * line) are subdivided so they follow the curve instead of cutting under it.
 */
function borderLines(lines: number[][], mat: LineMaterial, altitude: number) {
  const pos: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const l of lines) {
    for (let i = 0; i + 3 < l.length; i += 2) {
      const lon0 = l[i], lat0 = l[i + 1], lon1 = l[i + 2], lat1 = l[i + 3];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / 0.5));
      globePoint(lat0, lon0, altitude, a);
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        globePoint(lat0 + (lat1 - lat0) * t, lon0 + (lon1 - lon0) * t, altitude, b);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        a.copy(b);
      }
    }
  }
  const g = new LineSegmentsGeometry();
  g.setPositions(pos);
  const m = new LineSegments2(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 8;
  return m;
}

// --- labels (countries and states/provinces) --------------------------------------

interface GlobeLabel {
  kind: 'country' | 'state';
  name: string;
  min: number;
  s: THREE.Sprite;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  w: number;
  h: number;
}

let countries: CountryLabel[] = [];
const labels: GlobeLabel[] = [];
const LABEL_PX = { country: 21, state: 16 } as const;

function labelSprite(name: string, kind: GlobeLabel['kind']) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const px = LABEL_PX[kind] * 2;
  const font = `${kind === 'country' ? 600 : 500} ${px}px Inter, 'Segoe UI', system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.6);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.2;
  ctx.strokeStyle = 'rgba(16,22,30,0.85)';
  ctx.strokeText(name, w / 2, c.height / 2);
  ctx.fillStyle = kind === 'country' ? '#f4f7fb' : '#e3e9f1';
  ctx.fillText(name, w / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false, fog: false }));
  const h = LABEL_PX[kind] / 900;
  sprite.scale.set((h * c.width) / c.height, h, 1);
  sprite.renderOrder = kind === 'country' ? 31 : 30;
  sprite.visible = false;
  return { sprite, aspect: c.width / c.height };
}

function addLabel(group: THREE.Group, kind: GlobeLabel['kind'], name: string, lat: number, lon: number, min: number) {
  const { sprite, aspect } = labelSprite(name, kind);
  const pos = globePoint(lat, lon, 30_000);
  sprite.userData.label = name;
  sprite.position.copy(pos);
  group.add(sprite);
  labels.push({ kind, name, min, s: sprite, pos, normal: pos.clone().sub(EARTH_CENTER).normalize(), w: aspect * LABEL_PX[kind], h: LABEL_PX[kind] });
}

const tmp = new THREE.Vector3();
/**
 * Per-frame globe overlay: borders by zoom, and the country/state names that
 * face the camera and fit the zoom level (Natural Earth's min_label), most
 * important first, skipping any that would overlap.
 *   countries: from orbit down to ~300 km
 *   states:    from roughly continent zoom down to ~120 km (Indiana appears a
 *              few scroll steps in from the whole-US view)
 */
export function updateGlobeOverlay(camera: THREE.Camera, distance: number, width: number, height: number) {
  borders.visible = distance >= BORDERS_MIN_CAM;
  if (!labels.length) return;
  const zoom = Math.log2(3.5e7 / Math.max(distance, 1));
  const placed: [number, number, number, number][] = [];
  const toCam = new THREE.Vector3();
  for (const l of labels) {
    l.s.visible = false;
    if (placed.length >= 90) continue;
    if (l.kind === 'country' ? distance < 300_000 || l.min > zoom + 0.8 : distance < 120_000 || l.min > zoom + 0.2) continue;
    toCam.copy(camera.position).sub(l.pos).normalize();
    if (toCam.dot(l.normal) < 0.2) continue; // far side of the planet or right at the edge
    tmp.copy(l.pos).project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05) continue;
    const sx = (tmp.x * 0.5 + 0.5) * width, sy = (0.5 - tmp.y * 0.5) * height;
    const hw = l.w / 2 + 6, hh = l.h / 2 + 4;
    const r: [number, number, number, number] = [sx - hw, sy - hh, sx + hw, sy + hh];
    if (placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) continue;
    placed.push(r);
    l.s.visible = true;
  }
}

function buildOverlay(group: THREE.Group, data: Landmasses) {
  countries = data.countries ?? [];
  // Countries first so they win label collisions; states fill in around them.
  for (const c of countries) addLabel(group, 'country', c.n, c.lat, c.lon, c.min);
  for (const st of data.states ?? []) addLabel(group, 'state', st.n, st.lat, st.lon, st.min);
  if (data.countryBorders) borders.add(borderLines(data.countryBorders, borderMats.country, 1200));
  if (data.stateBorders) borders.add(borderLines(data.stateBorders, borderMats.state, 1000));
  group.add(borders);
}

/** Nearest country label point to a lat/lon (for the location display). */
export function nearestCountry(lat: number, lon: number): string {
  let best = { d: Infinity, n: '' };
  const DEG2 = Math.PI / 180;
  for (const c of countries) {
    const d = Math.acos(Math.min(1, Math.sin(lat * DEG2) * Math.sin(c.lat * DEG2) + Math.cos(lat * DEG2) * Math.cos(c.lat * DEG2) * Math.cos((lon - c.lon) * DEG2)));
    if (d < best.d) best = { d, n: c.n };
  }
  return best.d < 0.35 ? best.n : best.n ? 'Ocean' : '';
}

export interface GlobeObjects {
  group: THREE.Group;
  earth: THREE.Mesh;
  atmosphere: THREE.Mesh;
  stars: THREE.Points;
}

/** Builds the globe; land masses arrive asynchronously and repaint the texture. */
export function createGlobe(): GlobeObjects {
  const group = new THREE.Group();
  group.name = 'globe';
  // A few meters below the tangent plane so the flat map always wins near the origin.
  const earthMat = new THREE.MeshStandardMaterial({ map: paintTexture(null), roughness: 1, metalness: 0, fog: false });
  const earth = new THREE.Mesh(sphereGeometry(256, 128, -40), earthMat);
  earth.frustumCulled = false;
  const atmosphere = new THREE.Mesh(sphereGeometry(96, 48, R * 0.035), atmosphereMaterial());
  atmosphere.frustumCulled = false;
  const stars = makeStars();
  group.add(earth, atmosphere, stars);
  fetch('/world/globe/landmasses.json')
    .then((r) => (r.ok ? (r.json() as Promise<Landmasses>) : null))
    .then((data) => {
      if (!data) return;
      earthMat.map?.dispose();
      earthMat.map = paintTexture(data);
      earthMat.needsUpdate = true;
      buildOverlay(group, data);
    })
    .catch((err) => console.warn('globe land masses failed', err));
  return { group, earth, atmosphere, stars };
}

/** 0 at street/state zoom → 1 when looking at the whole planet. */
export function globeFactor(distance: number) {
  return THREE.MathUtils.smoothstep(distance, 150_000, 4_000_000);
}
