// Small 3D exterior preview with the selected floor shown as a slab of rooms.
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BuildingProfile, BuildingRecord, Floor } from '@indy/shared';
import { buildBuildingsMesh } from '../world/geometryBuilder.ts';
import { toGeometry } from '../world/materials.ts';
import { ROOM_COLORS } from './roomColors.ts';

function Controls({ radius }: { radius: number }) {
  const { camera, gl } = useThree();
  const ctl = useRef<OrbitControls>(null);
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true;
    c.autoRotate = true;
    c.autoRotateSpeed = 1.2;
    c.enablePan = false;
    c.minDistance = radius * 0.6;
    c.maxDistance = radius * 6;
    ctl.current = c;
    return () => c.dispose();
  }, [camera, gl, radius]);
  useFrame(() => ctl.current?.update());
  return null;
}

function Model({ record, profile, floor }: { record: BuildingRecord; profile: BuildingProfile; floor: Floor | null }) {
  const [cx, cy] = record.centroid;
  const geo = useMemo(() => {
    const m = buildBuildingsMesh([record]);
    const walls = toGeometry(m.walls), roofs = toGeometry(m.roofs);
    return { walls, roofs, edges: new THREE.EdgesGeometry(walls, 30) };
  }, [record]);
  const slab = useMemo(() => {
    if (!floor) return null;
    return floor.rooms.map((r) => {
      const shape = new THREE.Shape(r.poly.map((p) => new THREE.Vector2(p[0], p[1])));
      for (const h of r.holes ?? []) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      return { g, color: ROOM_COLORS[r.kind] };
    });
  }, [floor]);
  useEffect(() => () => { geo.walls.dispose(); geo.roofs.dispose(); geo.edges.dispose(); }, [geo]);
  useEffect(() => () => slab?.forEach((s) => s.g.dispose()), [slab]);
  const y = floor ? floor.elevation + 0.05 : 0;
  return (
    <group position={[-cx, -profile.height / 2, cy]}>
      <mesh geometry={geo.walls}>
        <meshStandardMaterial vertexColors transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.roofs}>
        <meshStandardMaterial vertexColors transparent opacity={0.3} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={geo.edges}>
        <lineBasicMaterial color="#9fdcff" transparent opacity={0.55} />
      </lineSegments>
      {slab && (
        <group position={[0, y, 0]}>
          {slab.map((s, i) => (
            <mesh key={i} geometry={s.g}>
              <meshBasicMaterial color={s.color} side={THREE.DoubleSide} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

export function BuildingPreview({ record, profile, floor }: { record: BuildingRecord; profile: BuildingProfile; floor: Floor | null }) {
  const radius = Math.max(12, Math.sqrt(profile.footprintArea) * 0.9, profile.height * 0.75);
  return (
    <Canvas className="preview-canvas" camera={{ position: [radius * 1.6, radius * 1.1, radius * 1.6], fov: 40, near: 0.5, far: radius * 20 }} dpr={[1, 2]}>
      <ambientLight intensity={1.1} />
      <directionalLight position={[50, 80, 30]} intensity={1.6} />
      <Model record={record} profile={profile} floor={floor} />
      <Controls radius={radius} />
    </Canvas>
  );
}
