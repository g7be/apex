// WebSocket client. Persistent guest identity: the server issues a secret
// token which is kept in localStorage. Use ?profile=<name> in the URL to keep
// several independent identities in one browser (handy for multiplayer tests).
import type { ClientMessage, Lease, ServerMessage } from '@indy/shared';
import { game } from '../state/store.ts';
import { local, remotes } from '../state/live.ts';
import { getBuilding } from '../world/worldData.ts';
import { SoloServer } from './soloServer.ts';

const params = new URLSearchParams(location.search);
const profile = params.get('profile')?.replace(/[^\w-]/g, '').slice(0, 24) || 'default';
const TOKEN_KEY = `indy.token.${profile}`;
const NAME_KEY = `indy.name.${profile}`;
const SOLO_KEY = `indy.solo.${profile}`;
const configuredServer = (import.meta.env.VITE_GAME_SERVER as string | undefined)?.trim();
/** ?solo=1 forces single-player. Without a configured server we also fall back to it when /ws is unreachable. */
const forceSolo = params.get('solo') === '1';

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

export const identity = {
  profile,
  hasToken: () => !!storage(TOKEN_KEY),
  savedName: () => storage(NAME_KEY) ?? '',
};

/**
 * WebSocket URL of the game server. Same origin by default (local dev and
 * `npm start`); when the client is hosted separately (e.g. Netlify), set
 * VITE_GAME_SERVER at build time to the server's http(s) URL.
 */
export function gameServerUrl() {
  if (configuredServer) return `${configuredServer.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

type Pending ={ resolve: (r: { ok: boolean; error?: string; lease?: Lease }) => void; timer: number };

class Connection {
  private ws: WebSocket | null = null;
  private req = 1;
  private pending = new Map<number, Pending>();
  private retry = 0;
  private sendTimer = 0;
  private lastSent = '';
  private kicked = false;
  private desiredName?: string;
  private everOpened = false;
  private solo: SoloServer | null = null;

  connect(name?: string) {
    if (name) {
      this.desiredName = name;
      storage(NAME_KEY, name);
    }
    this.kicked = false;
    if (this.solo) return this.solo.start(this.desiredName);
    if (forceSolo) return this.startSolo();
    if (this.ws) return;
    this.open();
  }

  private open() {
    game.set({ connection: 'connecting' });
    const ws = new WebSocket(gameServerUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.everOpened = true;
      this.raw({ t: 'hello', token: storage(TOKEN_KEY) ?? undefined, name: this.desiredName ?? identity.savedName() ?? undefined });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this.onMessage(JSON.parse(ev.data) as ServerMessage);
      } catch (err) {
        console.error('bad server message', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.sendTimer);
      game.set({ connection: 'offline' });
      for (const [, p] of this.pending) p.resolve({ ok: false, error: 'Connection lost' });
      this.pending.clear();
      if (this.kicked) return;
      // No server deployed alongside this client (static hosting): play solo instead.
      if (!this.everOpened && !configuredServer) return this.startSolo();
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private startSolo() {
    this.solo = new SoloServer(SOLO_KEY, (m) => this.onMessage(m));
    this.solo.start(this.desiredName ?? identity.savedName());
  }

  private raw(msg: ClientMessage) {
    if (this.solo) return this.solo.handle(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome': {
        storage(TOKEN_KEY, msg.token);
        storage(NAME_KEY, msg.you.name);
        const leases: Record<string, Lease> = {};
        for (const l of msg.leases) leases[l.buildingId] = l;
        const players: Record<string, { id: string; name: string; color: string }> = {};
        remotes.clear();
        for (const p of msg.players) {
          players[p.id] = { id: p.id, name: p.name, color: p.color };
          if (p.state) {
            const pos: [number, number, number] = [p.state.p[0], p.state.p[1], -p.state.p[2]];
            remotes.set(p.id, { pos: [...pos], target: pos, heading: p.state.ry, targetHeading: p.state.ry, anim: p.state.anim, in: p.state.in, lastUpdate: performance.now() });
          }
        }
        const first = !game.get().me;
        game.set({ connection: this.solo ? 'solo' : 'online', me: msg.you, config: msg.config, leases, players, serverTimeOffset: msg.serverTime - Date.now() });
        if (first) game.addChat({ from: null, text: `Welcome, ${msg.you.name}! Click any building to inspect it. Press H for controls.`, channel: 'system', ts: Date.now() });
        if (first && this.solo) game.addChat({ from: null, text: 'Playing solo: no game server is connected, so your balance and leases are saved in this browser only.', channel: 'system', ts: Date.now() });
        if (!this.solo) this.startSending();
        break;
      }
      case 'players': {
        const now = performance.now();
        for (const s of msg.states) {
          const target: [number, number, number] = [s.p[0], s.p[1], -s.p[2]];
          const r = remotes.get(s.id);
          if (r) Object.assign(r, { target, targetHeading: s.ry, anim: s.anim, in: s.in, lastUpdate: now });
          else remotes.set(s.id, { pos: [...target], target, heading: s.ry, targetHeading: s.ry, anim: s.anim, in: s.in, lastUpdate: now });
        }
        break;
      }
      case 'join':
        game.set((st) => ({ players: { ...st.players, [msg.player.id]: msg.player } }));
        game.addChat({ from: null, text: `${msg.player.name} joined downtown.`, channel: 'system', ts: Date.now() });
        break;
      case 'leave': {
        const name = game.get().players[msg.id]?.name;
        remotes.delete(msg.id);
        game.set((st) => {
          const players = { ...st.players };
          delete players[msg.id];
          return { players };
        });
        if (name) game.addChat({ from: null, text: `${name} left.`, channel: 'system', ts: Date.now() });
        break;
      }
      case 'renamed': {
        const me = game.get().me;
        if (me && msg.player.id === me.id) game.set({ me: { ...me, name: msg.player.name } });
        else game.set((st) => ({ players: { ...st.players, [msg.player.id]: msg.player } }));
        break;
      }
      case 'lease': {
        game.set((st) => {
          const leases = { ...st.leases };
          if (msg.lease) leases[msg.buildingId] = msg.lease;
          else delete leases[msg.buildingId];
          return { leases };
        });
        const me = game.get().me;
        if (msg.reason === 'rented' && msg.lease && msg.lease.playerId !== me?.id) {
          game.addChat({ from: null, text: `${msg.lease.playerName} leased a building.`, channel: 'system', ts: Date.now() });
        }
        if (msg.reason === 'expired' && game.get().selectedId === msg.buildingId) game.toast('The lease on this building expired; it is back on the market.');
        break;
      }
      case 'balance': {
        const me = game.get().me;
        if (me) game.set({ me: { ...me, balance: msg.balance } });
        break;
      }
      case 'result': {
        const p = this.pending.get(msg.req);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.req);
          p.resolve(msg);
        }
        break;
      }
      case 'chat':
        game.addChat({ from: msg.from, text: msg.text, channel: msg.channel, ts: msg.ts });
        break;
      case 'error':
        game.toast(msg.message, 'error');
        break;
      case 'kicked':
        this.kicked = true;
        game.toast(msg.reason, 'error');
        game.set({ connection: 'offline' });
        break;
      case 'pong':
        break;
    }
  }

  private startSending() {
    clearInterval(this.sendTimer);
    this.sendTimer = window.setInterval(() => {
      const msg: ClientMessage = {
        t: 'state',
        p: [round(local.pos[0]), round(local.pos[1]), round(-local.pos[2])],
        ry: Math.round(local.heading * 100) / 100,
        anim: local.anim,
        in: null,
      };
      const key = JSON.stringify(msg);
      if (key === this.lastSent) return;
      this.lastSent = key;
      this.raw(msg);
    }, 100);
  }

  request(msg: { t: 'rent' | 'renew' | 'release'; buildingId: string } | { t: 'rename'; buildingId: string; name: string }) {
    return new Promise<{ ok: boolean; error?: string; lease?: Lease }>((resolve) => {
      if (!this.solo && this.ws?.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: 'Not connected to the server.' });
      const req = this.req++;
      const timer = window.setTimeout(() => {
        this.pending.delete(req);
        resolve({ ok: false, error: 'The server did not respond.' });
      }, 8000);
      this.pending.set(req, { resolve, timer });
      // Tell the server which tile the building lives in (statewide buildings aren't preloaded).
      const tile = msg.t === 'rent' || msg.t === 'renew' ? getBuilding(msg.buildingId)?.tile : undefined;
      this.raw({ ...msg, req, ...(tile ? { tile } : {}) } as ClientMessage);
    });
  }

  chat(text: string, channel: 'global' | 'local') {
    this.raw({ t: 'chat', text, channel });
  }

  setName(name: string) {
    this.raw({ t: 'setName', name });
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

export const net = new Connection();
