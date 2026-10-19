// In-browser stand-in for the game server, used when no server is reachable
// (e.g. the client hosted alone on Netlify). Speaks the same protocol and
// follows the same lease rules as server/src/rentals.ts, but the player,
// balance and leases live in this browser's localStorage only.
import { colorForId, sanitizeName, type ClientMessage, type Lease, type PlayerSelf, type ServerConfigPublic, type ServerMessage } from '@indy/shared';
import { getBuilding } from '../world/worldData.ts';

const CONFIG: ServerConfigPublic = {
  leaseDurationMs: 24 * 3600_000,
  startingBalance: 25_000,
  chatRadius: 60,
  maxLeasesPerPlayer: 8,
  region: 'indianapolis-downtown',
};
const MAX_PREPAID_TERMS = 3;

interface SoloSave { you: PlayerSelf; leases: Lease[] }

export class SoloServer {
  private save: SoloSave;
  private sweep = 0;

  constructor(private key: string, private emit: (msg: ServerMessage) => void) {
    this.save = this.load() ?? this.fresh();
  }

  private load(): SoloSave | null {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? (JSON.parse(raw) as SoloSave) : null;
    } catch {
      return null;
    }
  }

  private fresh(): SoloSave {
    const id = `solo-${Math.random().toString(36).slice(2, 10)}`;
    return { you: { id, name: 'Guest', color: colorForId(id), balance: CONFIG.startingBalance, lastPosition: null, createdAt: Date.now() }, leases: [] };
  }

  private persist() {
    try { localStorage.setItem(this.key, JSON.stringify(this.save)); } catch { /* storage unavailable */ }
  }

  start(name?: string) {
    const clean = sanitizeName(name);
    if (clean) this.save.you.name = clean;
    for (const l of this.save.leases) l.playerName = this.save.you.name;
    this.expire();
    this.persist();
    this.emit({ t: 'welcome', token: 'solo', you: { ...this.save.you }, leases: this.save.leases, players: [], config: CONFIG, serverTime: Date.now() });
    clearInterval(this.sweep);
    this.sweep = window.setInterval(() => this.expire(), 5000);
  }

  private expire() {
    const now = Date.now();
    const due = this.save.leases.filter((l) => l.expiresAt <= now);
    if (!due.length) return;
    this.save.leases = this.save.leases.filter((l) => l.expiresAt > now);
    this.persist();
    for (const l of due) this.emit({ t: 'lease', buildingId: l.buildingId, lease: null, reason: 'expired' });
  }

  handle(msg: ClientMessage) {
    switch (msg.t) {
      case 'chat':
        this.emit({ t: 'chat', from: { id: this.save.you.id, name: this.save.you.name, color: this.save.you.color }, text: msg.text.slice(0, 240), channel: msg.channel, ts: Date.now() });
        break;
      case 'setName': {
        const clean = sanitizeName(msg.name);
        if (!clean) return this.emit({ t: 'error', message: 'Names must be 2–20 letters or numbers.' });
        this.save.you.name = clean;
        for (const l of this.save.leases) l.playerName = clean;
        this.persist();
        this.emit({ t: 'renamed', player: { id: this.save.you.id, name: clean, color: this.save.you.color } });
        break;
      }
      case 'rent': case 'renew': case 'release': case 'rename': {
        this.expire();
        const error = this[msg.t](msg as never);
        const lease = this.save.leases.find((l) => l.buildingId === msg.buildingId);
        if (!error) this.persist();
        this.emit({ t: 'result', req: msg.req, ok: !error, error: error ?? undefined, lease });
        break;
      }
    }
  }

  private charge(amount: number): string | null {
    if (this.save.you.balance < amount) return 'Not enough funds for the first month.';
    this.save.you.balance -= amount;
    this.emit({ t: 'balance', balance: this.save.you.balance });
    return null;
  }

  private rent(msg: { buildingId: string }): string | null {
    const b = getBuilding(msg.buildingId);
    if (!b) return 'That building does not exist in this region.';
    if (!b.profile.rentable) return 'This structure cannot be leased.';
    if (this.save.leases.some((l) => l.buildingId === msg.buildingId)) return 'You already lease this building.';
    if (this.save.leases.length >= CONFIG.maxLeasesPerPlayer) return 'You have reached the maximum number of leases.';
    const err = this.charge(b.profile.monthlyRent);
    if (err) return err;
    const now = Date.now();
    const you = this.save.you;
    const lease: Lease = {
      buildingId: msg.buildingId, playerId: you.id, playerName: you.name, playerColor: you.color,
      monthlyRent: b.profile.monthlyRent, startedAt: now, expiresAt: now + CONFIG.leaseDurationMs,
      customName: null, buildingName: b.profile.displayName, center: [b.record.centroid[0], b.record.centroid[1]], tile: b.tile,
    };
    this.save.leases.push(lease);
    this.emit({ t: 'lease', buildingId: msg.buildingId, lease, reason: 'rented' });
    return null;
  }

  private renew(msg: { buildingId: string }): string | null {
    const lease = this.save.leases.find((l) => l.buildingId === msg.buildingId);
    if (!lease) return 'You do not lease this building.';
    const now = Date.now();
    const expiresAt = Math.max(now, lease.expiresAt) + CONFIG.leaseDurationMs;
    if (expiresAt - now > MAX_PREPAID_TERMS * CONFIG.leaseDurationMs) return 'This lease is already prepaid the maximum number of terms ahead.';
    const price = getBuilding(msg.buildingId)?.profile.monthlyRent ?? lease.monthlyRent;
    const err = this.charge(price);
    if (err) return err;
    Object.assign(lease, { expiresAt, monthlyRent: price });
    this.emit({ t: 'lease', buildingId: msg.buildingId, lease, reason: 'renewed' });
    return null;
  }

  private release(msg: { buildingId: string }): string | null {
    if (!this.save.leases.some((l) => l.buildingId === msg.buildingId)) return 'You do not lease this building.';
    this.save.leases = this.save.leases.filter((l) => l.buildingId !== msg.buildingId);
    this.emit({ t: 'lease', buildingId: msg.buildingId, lease: null, reason: 'released' });
    return null;
  }

  private rename(msg: { buildingId: string; name: string }): string | null {
    const lease = this.save.leases.find((l) => l.buildingId === msg.buildingId);
    if (!lease) return 'You do not lease this building.';
    const clean = msg.name.replace(/[^\p{L}\p{N} _.,&'\-]/gu, '').trim().slice(0, 40);
    if (clean.length === 1) return 'Building names must be 2–40 characters.';
    lease.customName = clean || null;
    this.emit({ t: 'lease', buildingId: msg.buildingId, lease, reason: 'renamed' });
    return null;
  }
}
