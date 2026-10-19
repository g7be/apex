// Other players shown as map pins at the spot they are looking at.
// Pins keep a constant on-screen size at any zoom level.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGame } from '../state/store.ts';
import { remotes } from '../state/live.ts';

function nameTexture(name: string, color: string) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '600 44px Inter, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 70;
  c.width = w;
  c.height = 72;
  ctx.font = font;
  ctx.fillStyle = 'rgba(12,16,24,0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 4, w, 64, 32);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(34, 36, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2f6fb';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 54, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / 72 };
}

const pinHead = new THREE.SphereGeometry(1, 20, 14).translate(0, 3.2, 0);
const pinTip = new THREE.ConeGeometry(0.62, 2.4, 20).rotateX(Math.PI).translate(0, 1.4, 0);
const ringGeo = new THREE.RingGeometry(0.9, 1.25, 32).rotateX(-Math.PI / 2).translate(0, 0.2, 0);

function Marker({ id, name, color }: { id: string; name: string; color: string }) {
  const group = useRef<THREE.Group>(null);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.25 }), [color]);
  const tag = useMemo(() => nameTexture(name, color), [name, color]);

  useFrame(({ camera }) => {
    const r = remotes.get(id);
    const g = group.current;
    if (!g) return;
    g.visible = !!r;
    if (!r) return;
    g.position.set(r.pos[0], 0, r.pos[2]);
    // Constant screen size: scale with camera distance.
    g.scale.setScalar(THREE.MathUtils.clamp(camera.position.distanceTo(g.position) / 70, 0.6, 40));
  });

  return (
    <group ref={group}>
      <mesh geometry={pinHead} material={mat} />
      <mesh geometry={pinTip} material={mat} />
      <mesh geometry={ringGeo}>
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <sprite position={[0, 5.6, 0]} scale={[1.6 * tag.aspect, 1.6, 1]} renderOrder={10}>
        <spriteMaterial map={tag.tex} depthTest={false} transparent />
      </sprite>
    </group>
  );
}

export function PlayerMarkers() {
  const players = useGame((s) => s.players);

  useFrame((_, dt) => {
    const k = 1 - Math.pow(0.002, dt);
    for (const r of remotes.values()) {
      const jump = Math.hypot(r.target[0] - r.pos[0], r.target[2] - r.pos[2]);
      if (jump > 1500) r.pos = [...r.target];
      else for (let i = 0; i < 3; i++) r.pos[i] += (r.target[i] - r.pos[i]) * k;
    }
  });

  return (
    <>
      {Object.values(players).map((p) => <Marker key={p.id} id={p.id} name={p.name} color={p.color} />)}
    </>
  );
}
