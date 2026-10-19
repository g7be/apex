#!/usr/bin/env node
// Copies the static world data (city tiles, globe, statewide LOD tiles) into
// the client build (client/dist/world) so the client can be hosted on a static
// host (Netlify, etc.) without the game server serving /world/*. The client
// unzips the statewide .json.gz tiles itself when a host serves them raw.
import { cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'data/world');
const dist = path.join(root, 'client/dist');
if (!existsSync(dist)) {
  console.error('client/dist not found: run the client build first.');
  process.exit(1);
}

const copied = readdirSync(src);
for (const name of copied) cpSync(path.join(src, name), path.join(dist, 'world', name), { recursive: true });
console.log(`Copied world data into client/dist/world: ${copied.join(', ') || '(none)'}`);
