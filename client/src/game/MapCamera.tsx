// Aerial map camera (no walking avatar).
//   Left-drag      pan (the ground point under the cursor stays under it)
//   Mouse wheel    zoom toward the cursor
//   Right-drag     rotate / tilt
//   WASD / arrows  pan · Q / E rotate · + / − zoom
// The camera focus doubles as the player's "position" for multiplayer
// presence. Zooming out far enough blends the view into a whole-Earth view:
// the look-at point slides to the planet's center and the camera tilts to look
// straight down, so the globe ends up centered on screen.
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { cameraState, local } from '../state/live.ts';
import { game, useGame } from '../state/store.ts';
import { consumeMouse, keys } from './input.ts';
import { updateStreaming } from '../world/tileMeshes.ts';
import { updateMapLayers } from '../world/mapLayers.ts';
import { getManifest, neighborhoodAt, streetAt } from '../world/worldData.ts';
import { getStateManifest, inDetailRegion, nearestPlace } from '../world/stateData.ts';
import { EARTH_CENTER, R, flatToGeo, focusFrame, geoToFlat, globeFactor, nearestCountry } from '../world/globe.ts';
import { updateViewFrustum } from '../world/view.ts';

export const MIN_DISTANCE = 35;
export const MAX_DISTANCE = 30_000_000;
const MIN_PITCH = 0.35;
const MAX_PITCH = 1.5;

/** Where the camera is heading; the rendered camera eases toward it. */
export const cameraTarget = {
  focus: [0, 0, 0] as [number, number, number],
  distance: 420,
  yaw: 0.35,
  pitch: 0.95,
};

/** Jump the map to a point (three.js coords), optionally changing zoom. */
export function flyTo(x: number, z: number, distance?: number) {
  cameraTarget.focus = [x, 0, z];
  if (distance) setTargetDistance(distance);
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/** Above this camera distance the planet spins freely under the camera. */
export const GLOBE_FREE_CAM = 300_000;
/** Closest you can zoom outside the mapped region (there's no street data there). */
const OUTSIDE_MIN_CAM = 600_000;

function regionBounds() {
  const m = getStateManifest() ?? getManifest();
  return m?.bounds ?? null;
}

/** Is a flat focus point over the mapped region (the state, with some margin)? */
function overRegion(f: [number, number, number], pad = 60_000) {
  const b = regionBounds();
  if (!b) return true;
  const y = -f[2];
  return f[0] >= b[0] - pad && f[0] <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
}

/** Set the zoom target, stopping at orbit height when not over the mapped region. */
export function setTargetDistance(d: number) {
  const min = overRegion(cameraTarget.focus) ? MIN_DISTANCE : OUTSIDE_MIN_CAM;
  cameraTarget.distance = THREE.MathUtils.clamp(d, min, MAX_DISTANCE);
}

function clampFocus(f: [number, number, number], distance = cameraTarget.distance) {
  if (distance >= GLOBE_FREE_CAM) {
    // Spinning the globe: anywhere on Earth, minus the poles; wrap longitude.
    const g = flatToGeo(f[0], -f[2]);
    const lat = THREE.MathUtils.clamp(g.lat, -80, 80);
    const lon = ((((g.lon + 180) % 360) + 360) % 360) - 180;
    const [x, y] = geoToFlat(lat, lon);
    f[0] = x;
    f[2] = -y;
    return;
  }
  const b = regionBounds();
  if (!b) return;
  const pad = getStateManifest() ? 20_000 : 600;
  f[0] = THREE.MathUtils.clamp(f[0], b[0] - pad, b[2] + pad);
  f[2] = THREE.MathUtils.clamp(f[2], -b[3] - pad, -b[1] + pad);
}

/**
 * Move the focus by a surface displacement in meters along the camera's
 * screen axes, converting to flat coordinates (whose x stretches with latitude).
 */
function moveOnGlobe(f: [number, number, number], right: number, forward: number, yaw: number) {
  const east = right * Math.cos(yaw) - forward * Math.sin(yaw);
  const north = right * Math.sin(yaw) + forward * Math.cos(yaw);
  const g = flatToGeo(f[0], -f[2]);
  const k = Math.cos((39.7684 * Math.PI) / 180) / Math.max(0.15, Math.cos((g.lat * Math.PI) / 180));
  f[0] += east * k;
  f[2] -= north;
}

export function MapCamera() {
  const { camera, gl } = useThree();
  const timers = useRef({ loc: 0 });
  useEffect(() => { Object.assign(((globalThis as { __indy?: object }).__indy ??= {}), { camera }); }, [camera]);

  /** Position the camera from cameraState (current, not target). */
  const place = () => {
    const { focus, distance, yaw, pitch: userPitch } = cameraState;
    const g = globeFactor(distance);
    const pitch = THREE.MathUtils.lerp(userPitch, Math.PI / 2 - 1e-4, g);
    // 0 = flat-map placement (street/state zoom), 1 = placement on the curved Earth (orbit).
    const w = THREE.MathUtils.smoothstep(distance, 60_000, 400_000);
    // Near/far follow the zoom so the depth buffer stays useful from street level to orbit.
    const cam = camera as THREE.PerspectiveCamera;
    const near = Math.max(1, distance / 400);
    const far = Math.max(12_000, distance * 8, distance > 50_000 ? distance + 2.2 * R : 0);
    if (Math.abs(cam.near - near) > near * 0.2 || Math.abs(cam.far - far) > far * 0.2) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cpch = Math.cos(pitch);
    const down = THREE.MathUtils.smoothstep(pitch, 1.35, Math.PI / 2);
    // Flat placement: the local frame is x east, y up, z south.
    const flatFocus = new THREE.Vector3(focus[0], focus[1], focus[2]);
    const pos = new THREE.Vector3(focus[0] + sy * cpch * distance, focus[1] + sp * distance, focus[2] + cy * cpch * distance);
    const look = flatFocus.clone().lerp(EARTH_CENTER, g);
    // Looking straight down needs an "up" that isn't parallel to the view.
    const up = new THREE.Vector3(-sy * down, 1 - down, -cy * down).normalize();
    if (w > 0) {
      // Globe placement: same yaw/pitch, but in the local frame at the focus's lat/lon.
      const fr = focusFrame(focus[0], -focus[2]);
      const south = fr.north.clone().negate();
      const gPos = fr.point.clone()
        .addScaledVector(fr.east, sy * cpch * distance)
        .addScaledVector(fr.up, sp * distance)
        .addScaledVector(south, cy * cpch * distance);
      const gLook = fr.point.clone().lerp(EARTH_CENTER, g);
      const fwd = fr.east.clone().multiplyScalar(-sy).addScaledVector(fr.north, cy);
      const gUp = fr.up.clone().multiplyScalar(1 - down).addScaledVector(fwd, down).normalize();
      pos.lerp(gPos, w);
      look.lerp(gLook, w);
      up.lerp(gUp, w).normalize();
    }
    camera.position.copy(pos);
    camera.up.copy(up);
    camera.lookAt(look);
    updateViewFrustum(camera);
  };

  const groundAt = (clientX: number, clientY: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(GROUND, p) ? p : null;
  };

  // Left-drag panning and wheel zoom toward the cursor.
  useEffect(() => {
    const el = gl.domElement;
    let drag: { anchor: THREE.Vector3 } | null = null;
    let spin: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Snap the eased camera to its target so the drag anchor is exact.
      Object.assign(cameraState, { ...cameraTarget, focus: [...cameraTarget.focus] });
      place();
      if (cameraTarget.distance >= GLOBE_FREE_CAM) {
        spin = { x: e.clientX, y: e.clientY };
        return;
      }
      const anchor = groundAt(e.clientX, e.clientY);
      if (anchor) drag = { anchor };
    };
    const onMove = (e: PointerEvent) => {
      if (spin && e.buttons & 1) {
        // Spin the globe: the surface follows the cursor.
        const cam = camera as THREE.PerspectiveCamera;
        const h = el.getBoundingClientRect().height || 1;
        const visible = Math.min(2 * cameraTarget.distance * Math.tan((cam.fov * Math.PI) / 360), R * 2.2);
        const mpp = visible / h;
        const dx = e.clientX - spin.x, dy = e.clientY - spin.y;
        spin = { x: e.clientX, y: e.clientY };
        const f = cameraTarget.focus;
        moveOnGlobe(f, -dx * mpp, dy * mpp, cameraTarget.yaw);
        clampFocus(f);
        cameraState.focus = [...f];
        el.style.cursor = 'grabbing';
        return;
      }
      if (!drag || !(e.buttons & 1)) return;
      place();
      const now = groundAt(e.clientX, e.clientY);
      if (!now) return;
      const f = cameraState.focus;
      f[0] += drag.anchor.x - now.x;
      f[2] += drag.anchor.z - now.z;
      clampFocus(f);
      cameraTarget.focus = [...f];
      el.style.cursor = 'grabbing';
    };
    const onUp = () => {
      drag = null;
      spin = null;
      el.style.cursor = '';
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Faster steps when far out, so going from street to planet isn't a chore.
      const k = Math.pow(cameraTarget.distance > 100_000 ? 1.0025 : 1.0018, e.deltaY);
      // Zoom toward the cursor at map scale; toward the focus at planet scale.
      const before = cameraTarget.distance < 100_000 ? groundAt(e.clientX, e.clientY) : null;
      const prev = cameraTarget.distance;
      setTargetDistance(prev * k);
      const ratio = cameraTarget.distance / prev;
      // Keep the point under the cursor fixed while zooming.
      if (before) {
        const f = cameraTarget.focus;
        f[0] = before.x + (f[0] - before.x) * ratio;
        f[2] = before.z + (f[2] - before.z) * ratio;
        clampFocus(f);
      }
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);

  // Tile streaming on a timer, independent of the render loop.
  useEffect(() => {
    const tick = () => {
      const f = cameraState.focus;
      updateStreaming(f[0], -f[2], cameraState.distance);
      updateMapLayers(f[0], -f[2], cameraState.distance);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = useGame.getState();
    const { dx, dy } = consumeMouse();
    const typing = s.chatFocused || !!s.floorPlanFor || !!s.dialog;
    const t = cameraTarget;

    // Right-drag: rotate and tilt.
    t.yaw -= dx * 0.004;
    t.pitch = THREE.MathUtils.clamp(t.pitch + dy * 0.004, MIN_PITCH, MAX_PITCH);

    if (!typing) {
      const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      if (f || r) {
        const speed = Math.min(t.distance, R) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.4 : 1.1);
        if (t.distance >= GLOBE_FREE_CAM) moveOnGlobe(t.focus, r * speed * dt, f * speed * dt, t.yaw);
        else {
          const sy = Math.sin(t.yaw), cy = Math.cos(t.yaw);
          t.focus[0] += (-sy * f + cy * r) * speed * dt;
          t.focus[2] += (-cy * f - sy * r) * speed * dt;
        }
        clampFocus(t.focus);
      }
      if (keys.has('KeyQ')) t.yaw += 1.4 * dt;
      if (keys.has('KeyE')) t.yaw -= 1.4 * dt;
      if (keys.has('Equal') || keys.has('NumpadAdd')) setTargetDistance(t.distance * (1 - 1.6 * dt));
      if (keys.has('Minus') || keys.has('NumpadSubtract')) setTargetDistance(t.distance * (1 + 1.6 * dt));
    }

    // Ease the rendered camera toward the target.
    const k = 1 - Math.pow(0.0004, dt);
    const c = cameraState;
    for (let i = 0; i < 3; i++) c.focus[i] += (t.focus[i] - c.focus[i]) * k;
    c.distance += (t.distance - c.distance) * k;
    c.pitch += (t.pitch - c.pitch) * k;
    let dyaw = t.yaw - c.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    c.yaw += dyaw * k;
    place();

    // Presence for multiplayer = what you are looking at.
    local.pos = [c.focus[0], 0, c.focus[2]];
    local.heading = c.yaw + Math.PI;
    local.anim = 'idle';

    timers.current.loc -= dt;
    if (timers.current.loc <= 0) {
      timers.current.loc = 1;
      const fx = c.focus[0], fy = -c.focus[2];
      const inCity = !getStateManifest() || inDetailRegion(fx, fy);
      let neighborhood: string;
      if (c.distance > 150_000) {
        const geo = flatToGeo(fx, fy);
        neighborhood = overRegion(c.focus, 0) ? (getStateManifest()?.name ?? '') : nearestCountry(geo.lat, geo.lon) || 'Earth';
      } else neighborhood = inCity && c.distance < 9000 ? neighborhoodAt(fx, fy) : nearestPlace(fx, fy);
      const street = c.distance < 500 && inCity ? streetAt(fx, fy, 60) : '';
      if (neighborhood !== s.location.neighborhood || street !== s.location.street) game.set({ location: { neighborhood, street } });
    }
  });

  return null;
}
