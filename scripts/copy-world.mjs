#!/usr/bin/env node
// Copies the static world data into the client build (client/dist/world) so
// the client can be hosted on a static host (Netlify, etc.) without the game
// server serving /world/*.
//
// The statewide tiles (data/world/<state>/, ~150 MB of gzipped tiles) are left
// out by default: they're not in git, and static hosts would serve the .gz
// files without the gzip Content-Encoding the client expects. Set
// COPY_STATE=1 to include them anyway (serve them with that header yourself).
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

const copied = [];
for (const name of readdirSync(src)) {
  const dir = path.join(src, name);
  // State datasets carry a "layers" manifest and are only copied on request.
  const isState = existsSync(path.join(dir, 'detail'));
  if (isState && process.env.COPY_STATE !== '1') continue;
  cpSync(dir, path.join(dist, 'world', name), { recursive: true });
  copied.push(name);
}
console.log(`Copied world data into client/dist/world: ${copied.join(', ') || '(none)'}`);
