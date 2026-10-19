// HTTP + WebSocket server assembly. Exported for tests; see main.ts for the CLI entry.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { openDb, type Db } from './db.ts';
import { loadCatalog, type BuildingCatalog } from './catalog.ts';
import { PlayerRepo } from './players.ts';
import { RentalService } from './rentals.ts';
import { GameServer } from './game.ts';
import { ROOT, type ServerConfig } from './config.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache = 'no-cache') {
  // Revalidate by modification time so rebuilt world data is picked up immediately.
  const mtime = statSync(file).mtime;
  mtime.setMilliseconds(0);
  const since = req.headers['if-modified-since'];
  if (since && new Date(since).getTime() >= mtime.getTime()) {
    res.writeHead(304, { 'Cache-Control': cache });
    return res.end();
  }
  // Pre-gzipped tiles (*.json.gz) are sent as JSON with gzip content encoding.
  const gz = file.endsWith('.json.gz');
  res.writeHead(200, {
    'Content-Type': gz ? 'application/json' : MIME[path.extname(file)] ?? 'application/octet-stream',
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    'Cache-Control': cache,
    'Last-Modified': mtime.toUTCString(),
  });
  createReadStream(file).pipe(res);
}

/** Resolve a URL path inside a base directory, refusing traversal. */
function safeJoin(base: string, urlPath: string): string | null {
  const p = path.normalize(path.join(base, decodeURIComponent(urlPath)));
  return p.startsWith(base) ? p : null;
}

export interface RunningServer {
  port: number;
  db: Db;
  catalog: BuildingCatalog;
  rentals: RentalService;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig, opts: { catalog?: BuildingCatalog; now?: () => number } = {}): Promise<RunningServer> {
  const catalog = opts.catalog ?? loadCatalog(config.worldDir, config.region, config.stateRegion);
  const db = openDb(config.dbPath);
  const players = new PlayerRepo(db, config.startingBalance, opts.now);
  const rentals = new RentalService(db, catalog, {
    leaseDurationMs: config.leaseDurationMs,
    maxLeasesPerPlayer: config.maxLeasesPerPlayer,
    now: opts.now,
  });
  const clientDist = path.join(ROOT, 'client/dist');
  let game: GameServer;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/health') return json(200, { ok: true, region: catalog.region, buildings: catalog.size, online: game.onlineCount });
    if (url.pathname === '/api/leases') return json(200, { leases: rentals.activeLeases() });
    if (url.pathname.startsWith('/world/')) {
      const file = safeJoin(config.worldDir, url.pathname.slice('/world/'.length));
      if (file && existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file);
      return json(404, { error: 'not found' });
    }
    if (config.serveClient) {
      const file = safeJoin(clientDist, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file && existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file, file.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return serveFile(req, res, path.join(clientDist, 'index.html'));
    }
    json(404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  game = new GameServer(wss, players, rentals, catalog, config);

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    db,
    catalog,
    rentals,
    close: () => new Promise<void>((resolve) => {
      game.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => {
        db.close();
        resolve();
      });
    }),
  };
}
