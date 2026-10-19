// WebSocket protocol. JSON messages tagged by `t`. The server is authoritative
// for balances, prices, leases and identities; clients only send intents.

export type Anim = 'idle' | 'walk' | 'run' | 'jump';

export interface InteriorRef { b: string; f: number }

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
}

export interface PlayerState {
  id: string;
  /** Position in region-local meters: [x east, height, y north]. */
  p: [number, number, number];
  /** Heading in radians. */
  ry: number;
  anim: Anim;
  in: InteriorRef | null;
}

export interface PlayerSelf extends PlayerPublic {
  balance: number;
  lastPosition: [number, number, number] | null;
  createdAt: number;
}

export interface Lease {
  buildingId: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  monthlyRent: number;
  startedAt: number;
  expiresAt: number;
  customName: string | null;
  /** Building name and location at lease time, so far-away leases can be listed and flown to. */
  buildingName: string | null;
  center: [number, number] | null;
  tile: string | null;
}

export interface ServerConfigPublic {
  leaseDurationMs: number;
  startingBalance: number;
  chatRadius: number;
  maxLeasesPerPlayer: number;
  region: string;
}

export type ChatChannel = 'global' | 'local';

export type ClientMessage =
  | { t: 'hello'; token?: string; name?: string }
  | { t: 'state'; p: [number, number, number]; ry: number; anim: Anim; in: InteriorRef | null }
  | { t: 'chat'; text: string; channel: ChatChannel }
  | { t: 'rent'; req: number; buildingId: string; tile?: string }
  | { t: 'renew'; req: number; buildingId: string; tile?: string }
  | { t: 'release'; req: number; buildingId: string }
  | { t: 'rename'; req: number; buildingId: string; name: string }
  | { t: 'setName'; name: string }
  | { t: 'ping'; ts: number };

export type LeaseChangeReason = 'rented' | 'renewed' | 'released' | 'expired' | 'renamed';

export type ServerMessage =
  | {
    t: 'welcome';
    token: string;
    you: PlayerSelf;
    leases: Lease[];
    players: (PlayerPublic & { state: PlayerState | null })[];
    config: ServerConfigPublic;
    serverTime: number;
  }
  | { t: 'players'; states: PlayerState[] }
  | { t: 'join'; player: PlayerPublic }
  | { t: 'leave'; id: string }
  | { t: 'renamed'; player: PlayerPublic }
  | { t: 'lease'; buildingId: string; lease: Lease | null; reason: LeaseChangeReason }
  | { t: 'balance'; balance: number }
  | { t: 'result'; req: number; ok: boolean; error?: string; lease?: Lease }
  | { t: 'chat'; from: PlayerPublic; text: string; channel: ChatChannel; ts: number }
  | { t: 'error'; message: string }
  | { t: 'kicked'; reason: string }
  | { t: 'pong'; ts: number; serverTime: number };

export const NAME_MAX = 20;
export const CHAT_MAX = 240;

export function sanitizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const s = name.replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, NAME_MAX);
  return s.length >= 2 ? s : null;
}

/** Stable display color per player id. */
export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 55%)`;
}
