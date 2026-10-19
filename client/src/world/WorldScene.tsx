// Scene composition: sky, lighting, ground, streamed tiles, selection
// highlight, lease markers and building picking.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ensureCCW, type Vec2 } from '@indy/shared';
import { game, useGame } from '../state/store.ts';
import { cameraState } from '../state/live.ts';
import { pickBuilding, setLeaseTints, worldRoot } from './tileMeshes.ts';
import { buildBuildingsMesh } from './geometryBuilder.ts';
import { materials, toGeometry } from './materials.ts';
import { getBuilding } from './worldData.ts';
import { setLineResolution } from './mapLayers.ts';
import { EARTH_CENTER, GROUND_GREEN, R, createGlobe, setGlobeLineResolution, updateGlobeOverlay } from './globe.ts';

const SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();

/** Flat-map mode below this camera distance; the globe takes over above it. */
const GLOBE_MODE_CAM = 60_000;

function Environment() {
  const { scene, gl, camera } = useThree();
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const ground = useRef<THREE.Mesh>(null);
  const frame = useRef(0);
  const res = useMemo(() => new THREE.Vector2(), []);
  const space = useMemo(() => new THREE.Color('#03050a'), []);
  const globe = useMemo(() => createGlobe(), []);

  const sky = useMemo(() => {
    const s = new Sky();
    s.scale.setScalar(20000);
    const u = s.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(SUN_DIR).multiplyScalar(1000);
    return s;
  }, []);

  useEffect(() => {
    // Soft neutral image-based lighting so window glass has something to reflect.
    const pmrem = new THREE.PMREMGenerator(gl);
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.35;
    // The physical sky shader is HDR; this exposure keeps it from blowing out.
    gl.toneMappingExposure = 0.62;
    scene.fog = new THREE.Fog('#c9d6e2', 500, 2600);
    scene.background = null;
    return () => {
      rt.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, sky]);

  useFrame(() => {
    const d = cameraState.distance;
    const f = cameraState.focus;
    const cam3 = camera as THREE.PerspectiveCamera;
    const globeMode = d >= GLOBE_MODE_CAM;

    // Flat map: a big green ground disc that follows the view, fading into fog.
    if (ground.current) {
      ground.current.visible = !globeMode;
      ground.current.position.set(f[0], -0.02, f[2]);
    }
    // Globe: always there underneath; the only ground once zoomed out.
    globe.earth.visible = d > GLOBE_MODE_CAM * 0.8;
    globe.atmosphere.visible = d > 250_000;
    // Sky by day near the ground, black space with stars from orbit.
    sky.visible = d < 180_000;
    sky.position.copy(camera.position);
    sky.scale.setScalar(cam3.far * 0.9);
    scene.background = d < 180_000 ? null : space;
    globe.stars.visible = d > 150_000;
    globe.stars.position.copy(camera.position);
    globe.stars.scale.setScalar(cam3.far * 0.85);
    (globe.stars.material as THREE.PointsMaterial).opacity = THREE.MathUtils.smoothstep(d, 150_000, 600_000);

    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = globeMode ? 1e12 : d * 1.8 + 400;
      fog.far = globeMode ? 2e12 : d * 7 + 3000;
    }
    gl.getDrawingBufferSize(res);
    setLineResolution(res.x, res.y);
    setGlobeLineResolution(res.x, res.y);
    // Country/state names and borders on the globe.
    if (frame.current++ % 3 === 0) {
      const el = gl.domElement;
      updateGlobeOverlay(camera, d, el.clientWidth, el.clientHeight);
    }

    const l = sun.current;
    if (!l) return;
    if (d > GLOBE_MODE_CAM) {
      // From orbit, light whichever side of the planet you're looking at.
      const toCam = camera.position.clone().sub(EARTH_CENTER).normalize();
      const sunDir = toCam.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5).add(new THREE.Vector3(0, 0.25, 0)).normalize();
      l.position.copy(EARTH_CENTER).addScaledVector(sunDir, R * 3);
      l.target.position.copy(EARTH_CENTER);
      l.target.updateMatrixWorld();
      hemi.current?.position.copy(toCam);
      return;
    }
    hemi.current?.position.set(0, 1, 0);
    // Shadow camera follows the camera focus; only worth it when zoomed in.
    const span = THREE.MathUtils.clamp(d * 1.1, 120, 1400);
    const cam = l.shadow.camera as THREE.OrthographicCamera;
    if (cam.right !== span) {
      cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
      cam.updateProjectionMatrix();
    }
    const snap = span / 512;
    const fx = Math.round(f[0] / snap) * snap, fz = Math.round(f[2] / snap) * snap;
    l.position.set(fx + SUN_DIR.x * 600, SUN_DIR.y * 600, fz + SUN_DIR.z * 600);
    l.target.position.set(fx, 0, fz);
    l.target.updateMatrixWorld();
  });

  return (
    <>
      <primitive object={sky} />
      <primitive object={globe.group} />
      <hemisphereLight ref={hemi} args={['#dfe9f5', '#8a8172', 1.5]} />
      <directionalLight
        ref={sun}
        intensity={4}
        color="#fff3e2"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.6}
        shadow-camera-near={10}
        shadow-camera-far={1600}
      />
      <mesh ref={ground} rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[900_000, 64]} />
        <meshStandardMaterial color={GROUND_GREEN} roughness={1} />
      </mesh>
    </>
  );
}

/** Glowing shell + edge outline around the selected building. */
function SelectionHighlight() {
  const selectedId = useGame((s) => s.selectedId);
  const dataVersion = useGame((s) => s.dataVersion);
  const ringRef = useRef<THREE.Mesh>(null);

  const objs = useMemo(() => {
    if (!selectedId) return null;
    const b = getBuilding(selectedId);
    if (!b) return null;
    const mesh = buildBuildingsMesh([b.record]);
    const walls = toGeometry(mesh.walls);
    const roofs = toGeometry(mesh.roofs);
    const edges = new THREE.EdgesGeometry(walls, 35);
    const fp = ensureCCW(b.record.fp);
    // Ground ring around the footprint.
    const pos: number[] = [];
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i], c = fp[(i + 1) % fp.length];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const n: Vec2 = [(dy / L) * 1.2, (-dx / L) * 1.2];
      const A = [a[0], 0.15, -a[1]], C = [c[0], 0.15, -c[1]];
      const A2 = [a[0] + n[0], 0.15, -(a[1] + n[1])], C2 = [c[0] + n[0], 0.15, -(c[1] + n[1])];
      pos.push(...A, ...C, ...C2, ...A, ...C2, ...A2);
    }
    const ring = new THREE.BufferGeometry();
    ring.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return { walls, roofs, edges, ring };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, dataVersion]);

  useEffect(() => () => {
    if (objs) for (const g of Object.values(objs)) g.dispose();
  }, [objs]);

  useFrame(({ clock }) => {
    const m = ringRef.current?.material as THREE.MeshBasicMaterial | undefined;
    if (m) m.opacity = 0.45 + Math.sin(clock.elapsedTime * 3) * 0.25;
  });

  if (!objs) return null;
  return (
    <group>
      <mesh geometry={objs.walls} material={materials.highlight} renderOrder={2} />
      <mesh geometry={objs.roofs} material={materials.highlight} renderOrder={2} />
      <lineSegments geometry={objs.edges} material={materials.highlightEdges} renderOrder={3} />
      <mesh ref={ringRef} geometry={objs.ring} renderOrder={3}>
        <meshBasicMaterial color="#4fd1ff" transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Colored base outline + floating sign on every leased building. */
function LeaseMarkers() {
  const leases = useGame((s) => s.leases);
  const me = useGame((s) => s.me?.id ?? null);
  const dataVersion = useGame((s) => s.dataVersion);
  const group = useRef<THREE.Group>(null);

  useEffect(() => setLeaseTints(leases, me), [leases, me, dataVersion]);

  const items = useMemo(() => {
    const out: { id: string; geo: THREE.BufferGeometry; color: string; label: THREE.CanvasTexture; aspect: number; top: THREE.Vector3 }[] = [];
    for (const lease of Object.values(leases)) {
      const b = getBuilding(lease.buildingId);
      if (!b) continue;
      const fp = ensureCCW(b.record.fp);
      const pos: number[] = [];
      for (let i = 0; i < fp.length; i++) {
        const a = fp[i], c = fp[(i + 1) % fp.length];
        const dx = c[0] - a[0], dy = c[1] - a[1];
        const L = Math.hypot(dx, dy) || 1;
        const n: Vec2 = [(dy / L) * 0.7, (-dx / L) * 0.7];
        const A = [a[0], 0.13, -a[1]], C = [c[0], 0.13, -c[1]];
        const A2 = [a[0] + n[0], 0.13, -(a[1] + n[1])], C2 = [c[0] + n[0], 0.13, -(c[1] + n[1])];
        pos.push(...A, ...C, ...C2, ...A, ...C2, ...A2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mine = lease.playerId === me;
      const color = mine ? '#3ddc84' : lease.playerColor;
      const text = `${lease.customName ?? (mine ? 'Your property' : 'Leased')} · ${lease.playerName}`;
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      ctx.font = '600 40px Inter, system-ui, sans-serif';
      const w = Math.ceil(ctx.measureText(text).width) + 60;
      c.width = w; c.height = 64;
      ctx.font = '600 40px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(10,14,22,0.78)';
      ctx.beginPath(); ctx.roundRect(0, 0, w, 64, 14); ctx.fill();
      ctx.fillStyle = color; ctx.fillRect(0, 0, 10, 64);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, 30, 34);
      const label = new THREE.CanvasTexture(c);
      label.colorSpace = THREE.SRGBColorSpace;
      const ctr = b.record.centroid;
      out.push({ id: lease.buildingId, geo, color, label, aspect: w / 64, top: new THREE.Vector3(ctr[0], b.profile.height + b.profile.roofHeight + 6, -ctr[1]) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leases, me, dataVersion]);

  useEffect(() => () => items.forEach((i) => { i.geo.dispose(); i.label.dispose(); }), [items]);

  useFrame(({ camera }) => {
    // Fade signs by distance.
    group.current?.children.forEach((child) => {
      if (!(child as THREE.Sprite).isSprite) return;
      const d = camera.position.distanceTo(child.position);
      child.visible = d < 700;
      const s = THREE.MathUtils.clamp(d / 28, 2.2, 18);
      const aspect = child.userData.aspect as number;
      child.scale.set(s * aspect * 0.5, s * 0.5, 1);
    });
  });

  return (
    <group ref={group}>
      {items.map((i) => (
        <mesh key={`r-${i.id}`} geometry={i.geo} renderOrder={1}>
          <meshBasicMaterial color={i.color} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {items.map((i) => (
        <sprite key={`s-${i.id}`} position={i.top} userData={{ aspect: i.aspect }}>
          <spriteMaterial map={i.label} depthTest={false} transparent />
        </sprite>
      ))}
    </group>
  );
}

/** Click (without dragging) to select a building. */
function Picking() {
  const { camera, gl, scene } = useThree();
  useEffect(() => {
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      const rect = gl.domElement.getBoundingClientRect();
      const locked = document.pointerLockElement === gl.domElement;
      const ndc = locked ? new THREE.Vector2(0, 0) : new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = pickBuilding(ray);
      game.set({ selectedId: hit ? hit.id : null });
    };
    gl.domElement.addEventListener('pointerdown', onDown);
    gl.domElement.addEventListener('pointerup', onUp);
    return () => {
      gl.domElement.removeEventListener('pointerdown', onDown);
      gl.domElement.removeEventListener('pointerup', onUp);
    };
  }, [camera, gl, scene]);
  return null;
}

export function WorldScene() {
  return (
    <>
      <Environment />
      <primitive object={worldRoot} />
      <SelectionHighlight />
      <LeaseMarkers />
      <Picking />
    </>
  );
}

