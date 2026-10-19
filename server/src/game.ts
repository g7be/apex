// Real-time multiplayer over WebSockets: sessions, movement fan-out with an
// interest radius, chat, and rental intents routed to the RentalService.
import type { WebSocket, WebSocketServer } from 'ws';
import {
  CHAT_MAX, type ClientMessage, type InteriorRef, type Lease, type LeaseChangeReason, type PlayerState, type ServerMessage,
} from '@indy/shared';
import { PlayerRepo, type PlayerRow } from './players.ts';
import { RENTAL_ERROR_TEXT, type RentalResult, type RentalService } from './rentals.ts';
import type { BuildingCatalog } from './catalog.ts';
import type { ServerConfig } from './config.ts';

interface Session {
  ws: WebSocket;
  player: PlayerRow;
  state: PlayerState | null;
  dirty: boolean;
  lastPersist: number;
  lastChat: number;
  chatBurst: number;
  alive: boolean;
}

const TICK_MS = 100;
const PERSIST_MS = 5_000;
const EXPIRY_SWEEP_MS = 5_000;

export class GameServer {
  private sessions = new Map<WebSocket, Session>();
  private byPlayer = new Map<string, Session>();
  private timers: NodeJS.Timeout[] = [];
  private closed = false;

  constructor(
    wss: WebSocketServer,
    private players: PlayerRepo,
    private rentals: RentalService,
    private catalog: BuildingCatalog,
    private config: ServerConfig,
  ) {
    wss.on('connection', (ws) => this.onConnection(ws));
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.sweepExpired(), EXPIRY_SWEEP_MS));
    this.timers.push(setInterval(() => this.heartbeat(), 15_000));
  }

  get onlineCount() {
    return this.byPlayer.size;
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    for (const s of this.sessions.values()) this.persist(s);
    this.closed = true;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except?: Session) {
    const data = JSON.stringify(msg);
    for (const s of this.byPlayer.values()) if (s !== except && s.ws.readyState === s.ws.OPEN) s.ws.send(data);
  }

  private onConnection(ws: WebSocket) {
    let session: Session | null = null;
    const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), 10_000);
    ws.on('pong', () => { if (session) session.alive = true; });
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('bad message');
      } catch {
        return this.send(ws, { t: 'error', message: 'Malformed message' });
      }
      if (this.closed) return;
      if (!session) {
        if (msg.t !== 'hello') return this.send(ws, { t: 'error', message: 'Say hello first' });
        clearTimeout(helloTimer);
        session = this.onHello(ws, msg);
        return;
      }
      try {
        this.onMessage(session, msg);
      } catch (err) {
        console.error('message handler error', err);
        this.send(ws, { t: 'error', message: 'Server error' });
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!session || this.closed) return;
      this.sessions.delete(ws);
      this.persist(session);
      if (this.byPlayer.get(session.player.id) === session) {
        this.byPlayer.delete(session.player.id);
        this.broadcast({ t: 'leave', id: session.player.id });
      }
    });
  }

  private onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: 'hello' }>): Session {
    const { player, token } = this.players.login(msg.token, msg.name);
    // One live session per player: a newer tab replaces the older one.
    const prev = this.byPlayer.get(player.id);
    if (prev) {
      this.send(prev.ws, { t: 'kicked', reason: 'You connected from another tab or window.' });
      this.byPlayer.delete(player.id);
      prev.ws.close(4001, 'replaced');
    }
    const session: Session = { ws, player, state: null, dirty: false, lastPersist: Date.now(), lastChat: 0, chatBurst: 0, alive: true };
    if (player.pos_x != null) {
      session.state = { id: player.id, p: [player.pos_x, player.pos_y ?? 0, player.pos_z ?? 0], ry: player.heading ?? 0, anim: 'idle', in: null };
    }
    this.sessions.set(ws, session);
    this.byPlayer.set(player.id, session);
    this.rentals.expireDue();
    this.send(ws, {
      t: 'welcome',
      token,
      you: PlayerRepo.toSelf(player),
      leases: this.rentals.activeLeases(),
      players: [...this.byPlayer.values()].filter((s) => s !== session).map((s) => ({ ...PlayerRepo.toPublic(s.player), state: s.state })),
      config: {
        leaseDurationMs: this.config.leaseDurationMs,
        startingBalance: this.config.startingBalance,
        chatRadius: this.config.chatRadius,
        maxLeasesPerPlayer: this.config.maxLeasesPerPlayer,
        region: this.catalog.region,
      },
      serverTime: Date.now(),
    });
    this.broadcast({ t: 'join', player: PlayerRepo.toPublic(player) }, session);
    return session;
  }

  private validInterior(v: unknown, playerId: string): InteriorRef | null {
    if (!v || typeof v !== 'object') return null;
    const r = v as InteriorRef;
    if (typeof r.b !== 'string' || !Number.isInteger(r.f) || r.f < 0 || r.f > 200) return null;
    const entry = this.catalog.get(r.b);
    if (!entry) return null;
    // Leased buildings are private to their tenant.
    const lease = this.rentals.leaseFor(r.b);
    if (lease && lease.playerId !== playerId) return null;
    return { b: r.b, f: Math.min(r.f, entry.profile.floors - 1) };
  }

  private onMessage(s: Session, msg: ClientMessage) {
    switch (msg.t) {
      case 'state': {
        const p = msg.p;
        if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
        const [bx0, by0, bx1, by1] = this.catalog.bounds;
        const pad = 300;
        const clamped: [number, number, number] = [
          Math.max(bx0 - pad, Math.min(bx1 + pad, p[0])),
          Math.max(-10, Math.min(1000, p[1])),
          Math.max(by0 - pad, Math.min(by1 + pad, p[2])),
        ];
        const anim = ['idle', 'walk', 'run', 'jump'].includes(msg.anim) ? msg.anim : 'idle';
        const inside = this.validInterior(msg.in, s.player.id);
        s.state = { id: s.player.id, p: clamped, ry: Number.isFinite(msg.ry) ? msg.ry : 0, anim, in: inside };
        s.dirty = true;
        return;
      }
      case 'chat': {
        const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX) : '';
        if (!text) return;
        const now = Date.now();
        s.chatBurst = Math.max(0, s.chatBurst - (now - s.lastChat) / 1000) + 1;
        s.lastChat = now;
        if (s.chatBurst > 5) return this.send(s.ws, { t: 'error', message: 'You are sending messages too quickly.' });
        const channel = msg.channel === 'local' ? 'local' : 'global';
        const out: ServerMessage = { t: 'chat', from: PlayerRepo.toPublic(s.player), text, channel, ts: now };
        if (channel === 'global') return this.broadcast(out);
        for (const o of this.byPlayer.values()) {
          if (o === s || (o.state && s.state && dist2(o.state, s.state) <= this.config.chatRadius ** 2)) this.send(o.ws, out);
        }
        return;
      }
      case 'rent': return this.respond(s, msg.req, this.rentals.rent(s.player.id, String(msg.buildingId), typeof msg.tile === 'string' ? msg.tile : undefined), 'rented');
      case 'renew': return this.respond(s, msg.req, this.rentals.renew(s.player.id, String(msg.buildingId), typeof msg.tile === 'string' ? msg.tile : undefined), 'renewed');
      case 'release': {
        const res = this.rentals.release(s.player.id, String(msg.buildingId));
        this.sendResult(s, msg.req, res);
        if (res.ok) this.broadcast({ t: 'lease', buildingId: res.lease.buildingId, lease: null, reason: 'released' });
        return;
      }
      case 'rename': return this.respond(s, msg.req, this.rentals.rename(s.player.id, String(msg.buildingId), msg.name), 'renamed');
      case 'setName': {
        const name = this.players.rename(s.player.id, msg.name);
        if (!name) return this.send(s.ws, { t: 'error', message: 'Names must be 2–20 letters, numbers or spaces.' });
        s.player = { ...s.player, name };
        this.broadcast({ t: 'renamed', player: PlayerRepo.toPublic(s.player) });
        for (const lease of this.rentals.leasesOf(s.player.id)) this.broadcast({ t: 'lease', buildingId: lease.buildingId, lease, reason: 'renamed' });
        return;
      }
      case 'ping': return this.send(s.ws, { t: 'pong', ts: msg.ts, serverTime: Date.now() });
      case 'hello': return;
    }
  }

  private sendResult(s: Session, req: number, res: RentalResult) {
    if (res.ok) {
      s.player = { ...s.player, balance: res.balance };
      this.send(s.ws, { t: 'result', req, ok: true, lease: res.lease });
      this.send(s.ws, { t: 'balance', balance: res.balance });
    } else {
      this.send(s.ws, { t: 'result', req, ok: false, error: RENTAL_ERROR_TEXT[res.error] });
    }
  }

  private respond(s: Session, req: number, res: RentalResult, reason: LeaseChangeReason) {
    this.sendResult(s, req, res);
    if (res.ok) this.broadcastLease(res.lease, reason);
  }

  private broadcastLease(lease: Lease, reason: LeaseChangeReason) {
    this.broadcast({ t: 'lease', buildingId: lease.buildingId, lease, reason });
  }

  private tick() {
    const all = [...this.byPlayer.values()];
    if (!all.some((s) => s.dirty)) return;
    const r2 = this.config.interestRadius ** 2;
    for (const viewer of all) {
      const states: PlayerState[] = [];
      for (const o of all) {
        if (o === viewer || !o.state || !o.dirty) continue;
        if (viewer.state && dist2(viewer.state, o.state) > r2) continue;
        states.push(o.state);
      }
      if (states.length) this.send(viewer.ws, { t: 'players', states });
    }
    const now = Date.now();
    for (const s of all) {
      s.dirty = false;
      if (now - s.lastPersist > PERSIST_MS) this.persist(s);
    }
  }

  private persist(s: Session) {
    s.lastPersist = Date.now();
    if (s.state) this.players.savePosition(s.player.id, s.state.p, s.state.ry);
  }

  private sweepExpired() {
    for (const buildingId of this.rentals.expireDue()) this.broadcast({ t: 'lease', buildingId, lease: null, reason: 'expired' });
  }

  private heartbeat() {
    for (const s of this.sessions.values()) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      s.ws.ping();
    }
  }
}

function dist2(a: PlayerState, b: PlayerState) {
  const dx = a.p[0] - b.p[0], dz = a.p[2] - b.p[2];
  return dx * dx + dz * dz;
}
