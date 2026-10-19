// The camera's view frustum, updated every frame by the map camera, so tile
// streaming can skip anything the player can't see. (three.js already skips
// drawing off-screen meshes; this also skips downloading and building them.)
import * as THREE from 'three';

const frustum = new THREE.Frustum();
const m = new THREE.Matrix4();
const box = new THREE.Box3();
let valid = false;

export function updateViewFrustum(camera: THREE.Camera) {
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(m);
  valid = true;
}

/**
 * Whether a ground rectangle (local x east / y north meters) is in view.
 * `margin` grows it so tiles just off-screen are ready before they scroll in.
 */
export function rectInView(bounds: [number, number, number, number], margin = 0, height = 300) {
  if (!valid) return true;
  const [x0, y0, x1, y1] = bounds;
  box.min.set(x0 - margin, -50, -(y1 + margin));
  box.max.set(x1 + margin, height, -(y0 - margin));
  return frustum.intersectsBox(box);
}

export function pointInView(x: number, yNorth: number, h = 0) {
  if (!valid) return true;
  return frustum.containsPoint(new THREE.Vector3(x, h, -yNorth));
}
