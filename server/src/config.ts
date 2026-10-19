import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ServerConfig {
  port: number;
  dbPath: string;
  region: string;
  /** Optional statewide LOD data (data/world/<stateRegion>). */
  stateRegion: string;
  worldDir: string;
  startingBalance: number;
  leaseDurationMs: number;
  maxLeasesPerPlayer: number;
  chatRadius: number;
  interestRadius: number;
  /** Serve the built client from client/dist (production mode). */
  serveClient: boolean;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);
  return {
    port: num(env.GAME_PORT, 8787),
    dbPath: path.resolve(ROOT, env.DB_PATH ?? 'server/data/game.db'),
    region: env.REGION ?? 'indianapolis-downtown',
    stateRegion: env.STATE_REGION ?? 'indiana',
    worldDir: path.resolve(ROOT, env.WORLD_DIR ?? 'data/world'),
    startingBalance: Math.round(num(env.STARTING_BALANCE, 25_000)),
    leaseDurationMs: num(env.LEASE_DURATION_HOURS, 24) * 3_600_000,
    maxLeasesPerPlayer: num(env.MAX_LEASES_PER_PLAYER, 8),
    chatRadius: num(env.CHAT_RADIUS, 150),
    interestRadius: num(env.INTEREST_RADIUS, 1500),
    serveClient: existsSync(path.join(ROOT, 'client/dist/index.html')),
    ...overrides,
  };
}
