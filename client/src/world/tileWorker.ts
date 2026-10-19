/// <reference lib="webworker" />
// Builds tile geometry off the main thread and transfers the buffers back.
import type { TileData } from '@indy/shared';
import { buildBuildingsMesh, buildGroundMesh, offsetBuf, type BufOut } from './geometryBuilder.ts';

declare const self: DedicatedWorkerGlobalScope;

const buffersOf = (b: BufOut) => Object.values(b).map((a) => (a as Float32Array).buffer);

self.onmessage = (e: MessageEvent<{ job: number; tile: TileData; lite?: boolean; origin?: [number, number] }>) => {
  const { job, tile, lite = false, origin = [0, 0] } = e.data;
  try {
    const buildings = buildBuildingsMesh(tile.buildings, lite);
    const ground = buildGroundMesh(tile, lite);
    for (const b of [buildings.walls, buildings.roofs, buildings.details, ground.ground]) offsetBuf(b, origin[0], origin[1]);
    for (let i = 0; i < ground.trees.length; i += 4) {
      ground.trees[i] -= origin[0];
      ground.trees[i + 1] -= origin[1];
    }
    const transfer = [...buffersOf(buildings.walls), ...buffersOf(buildings.roofs), ...buffersOf(buildings.details), ...buffersOf(ground.ground), ground.trees.buffer];
    self.postMessage({ job, key: tile.key, buildings, ground }, transfer);
  } catch (err) {
    self.postMessage({ job, key: tile.key, error: String(err) });
  }
};
