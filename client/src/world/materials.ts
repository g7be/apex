// Shared materials. The facade material injects a procedural window pattern
// into MeshStandardMaterial, driven by per-vertex attributes:
//   aGrid   = (bay coordinate along the wall, floor coordinate up the wall)
//   aFacade = (style index, window ratio, floor count, storefront flag)
//   aSeed   = per-building random value
import * as THREE from 'three';
import type { BufOut } from './geometryBuilder.ts';

export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aGrid;
attribute vec4 aFacade;
attribute float aSeed;
varying vec2 vGrid;
varying vec4 vFacade;
varying float vSeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vGrid = aGrid; vFacade = aFacade; vSeed = aSeed;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vGrid;
varying vec4 vFacade;
varying float vSeed;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float winMask = 0.0;
float frameMask = 0.0;
{
  float style = vFacade.x;
  float wr = vFacade.y;
  float floors = vFacade.z;
  vec2 cell = floor(vGrid);
  vec2 f = fract(vGrid);
  float n = h21(cell + vSeed * 17.0);
  // Subtle per-panel variation so walls don't look flat.
  diffuseColor.rgb *= 0.93 + 0.1 * h21(cell * 0.37 + vSeed);
  if (wr > 0.01 && vGrid.y >= 0.0 && cell.y < floors) {
    bool ground = cell.y < 1.0 && vFacade.w > 0.5;
    float hx = wr * 0.5;
    float y0 = 0.3, y1 = 0.84;
    if (style < 0.5) { hx = 0.48; y0 = 0.14; y1 = 0.97; }
    else if (style > 5.5 && style < 6.5) { hx = 0.5; y0 = 0.36; y1 = 0.9; }
    else if (style > 6.5) { y0 = 0.22; y1 = 0.88; }
    if (ground) { hx = 0.45; y0 = 0.05; y1 = 0.8; }
    float inX = step(0.5 - hx, f.x) * step(f.x, 0.5 + hx);
    float inY = step(y0, f.y) * step(f.y, y1);
    winMask = inX * inY;
    // Mullions / frames.
    float mx = min(abs(f.x - (0.5 - hx)), abs(f.x - (0.5 + hx)));
    float my = min(abs(f.y - y0), abs(f.y - y1));
    frameMask = (1.0 - winMask) * step(mx, 0.04) * step(y0 - 0.04, f.y) * step(f.y, y1 + 0.04)
              + (1.0 - winMask) * step(my, 0.03) * inX;
    if (style < 0.5) frameMask += winMask * step(abs(f.x - 0.5), 0.012);
    vec3 glass = mix(vec3(0.055, 0.075, 0.1), vec3(0.2, 0.26, 0.32), n * 0.6 + f.y * 0.25);
    if (style > 5.5 && style < 6.5) glass = vec3(0.04, 0.04, 0.045);
    if (ground) glass = mix(vec3(0.07, 0.08, 0.09), vec3(0.32, 0.3, 0.26), step(0.7, n) * 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, clamp(frameMask, 0.0, 1.0) * 0.7);
  }
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, winMask);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.55, winMask);`);
  };
  mat.customProgramCacheKey = () => 'facade-v1';
  return mat;
}

export const materials = {
  facade: createFacadeMaterial(),
  roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }),
  /** Statewide low-detail walls: plain vertex colors, no window shader. */
  wallLite: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0 }),
  detail: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }),
  ground: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  highlight: new THREE.MeshBasicMaterial({
    color: '#4fd1ff', transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
  highlightEdges: new THREE.LineBasicMaterial({ color: '#7fe3ff', transparent: true, opacity: 0.95 }),
  trunk: new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: 1 }),
  crown: [
    new THREE.MeshStandardMaterial({ color: '#4d7a3a', roughness: 0.9, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: '#5d8a40', roughness: 0.9, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: '#41693a', roughness: 0.9, flatShading: true }),
  ],
};

export function toGeometry(b: BufOut): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(b.color, 3));
  if (b.grid) g.setAttribute('aGrid', new THREE.BufferAttribute(b.grid, 2));
  if (b.facade) g.setAttribute('aFacade', new THREE.BufferAttribute(b.facade, 4));
  if (b.seed) g.setAttribute('aSeed', new THREE.BufferAttribute(b.seed, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
