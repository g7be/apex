import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { centroid, deriveProfile, ensureCCW, type BuildingRecord, type ServerMessage, type Vec2, type WorldManifest } from '@indy/shared';
import type { BuildingCatalog, CatalogEntry } from '../src/catalog.ts';
import type { ServerConfig } from '../src/config.ts';

const rect = (x: number, y: number, w: number, h: number): Vec2[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

export function fakeCatalog(): BuildingCatalog {
  const raw: BuildingRecord[] = [
    { id: 'osm:w1', osm: 'way/1', fp: rect(0, 0, 12, 15), tags: { building: 'retail' }, front: 0, centroid: [6, 7.5] },
    { id: 'osm:w2', osm: 'way/2', fp: rect(40, 0, 30, 25), tags: { building: 'office', 'building:levels': '6' }, front: 0, centroid: [55, 12.5] },
    { id: 'osm:w3', osm: 'way/3', fp: rect(100, 0, 80, 60), tags: { building: 'office', 'building:levels': '40' }, front: 0, centroid: [140, 30] },
    { id: 'osm:w4', osm: 'way/4', fp: rect(0, 50, 6, 6), tags: { building: 'roof' }, front: 0, centroid: [3, 53] },
  ];
  const recs = raw.map((r) => ({ ...r, fp: ensureCCW(r.fp), centroid: centroid(r.fp) }));
  const index = new Map<string, CatalogEntry>(recs.map((r) => [r.id, { record: r, profile: deriveProfile(r), tile: '16-0-0' }]));
  const manifest = { bounds: [-500, -500, 500, 500], name: 'Test City', tiles: [] } as unknown as WorldManifest;
  return { region: 'test-region', manifest, bounds: manifest.bounds, get: (id) => index.get(id), size: index.size };
}

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'indy-test-'));
  return { dir, db: path.join(dir, 'game.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dbPath: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0, dbPath, region: 'test-region', stateRegion: '', worldDir: '', startingBalance: 25_000, leaseDurationMs: 24 * 3_600_000,
    maxLeasesPerPlayer: 8, chatRadius: 150, interestRadius: 1500, serveClient: false, ...overrides,
  };
}

/** Minimal test client that records every server message. */
export class TestClient {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private req = 1;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeout = 3000) {
    const match = (m: ServerMessage) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>);
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
      this.waiters.push({ pred: match, resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); } });
    });
  }

  async hello(token?: string, name?: string) {
    await this.opened();
    this.send({ t: 'hello', token, name });
    return this.wait('welcome');
  }

  async request(t: 'rent' | 'renew' | 'release', buildingId: string) {
    const req = this.req++;
    this.send({ t, req, buildingId });
    return this.wait('result', (m) => m.req === req);
  }

  close() {
    this.ws.close();
  }
}
