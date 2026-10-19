// Mutable per-frame state shared between the game loop, networking and the
// map layers. Not reactive on purpose.
import type { Anim, InteriorRef } from '@indy/shared';

export interface LocalPlayer {
  /** three.js world position (x, height, z = -north). */
  pos: [number, number, number];
  vel: [number, number, number];
  heading: number;
  anim: Anim;
  grounded: boolean;
}

export const local: LocalPlayer = {
  pos: [0, 0, 0],
  vel: [0, 0, 0],
  heading: 0,
  anim: 'idle',
  grounded: true,
};

/** Current (eased) aerial camera: orbit around a ground focus point. */
export const cameraState = {
  yaw: 0.35,
  pitch: 0.95,
  distance: 420,
  /** Ground point the camera looks at, three.js coords. */
  focus: [0, 0, 0] as [number, number, number],
};

export interface RemoteLive {
  pos: [number, number, number];
  target: [number, number, number];
  heading: number;
  targetHeading: number;
  anim: Anim;
  in: InteriorRef | null;
  lastUpdate: number;
}

export const remotes = new Map<string, RemoteLive>();

/** Convert region-local (x east, y north) to three.js (x, -north). */
export const toThree = (x: number, yNorth: number, h = 0): [number, number, number] => [x, h, -yNorth];
