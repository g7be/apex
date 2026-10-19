import { loadConfig } from './config.ts';
import { startServer } from './app.ts';

const config = loadConfig();
const server = await startServer(config);
console.log(`[server] ${server.catalog.manifest.name}: ${server.catalog.size} buildings, ${server.rentals.activeLeases().length} active leases`);
console.log(`[server] listening on http://localhost:${server.port}  (ws: /ws)${config.serveClient ? '  — serving client/dist' : ''}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
