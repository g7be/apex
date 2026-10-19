import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';

// Static world data (data/world) and the game API are both served by the game
// server; Vite proxies them in development so there is a single origin.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@indy/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/world': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
