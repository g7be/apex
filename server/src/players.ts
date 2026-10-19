// Persistent guest identities. A random secret token (kept by the browser)
// maps to a player; only its SHA-256 hash is stored.
import { createHash, randomBytes } from 'node:crypto';
import { colorForId, sanitizeName, type PlayerPublic, type PlayerSelf } from '@indy/shared';
import { transaction, type Db } from './db.ts';

export interface PlayerRow {
  id: string;
  name: string;
  balance: number;
  created_at: number;
  last_seen: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  heading: number | null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class PlayerRepo {
  constructor(private db: Db, private startingBalance: number, private now: () => number = Date.now) {}

  /** Resolve a token to a player, creating a new guest when the token is missing or unknown. */
  login(token: string | undefined, requestedName?: string): { player: PlayerRow; token: string; created: boolean } {
    if (typeof token === 'string' && token.length >= 16 && token.length <= 128) {
      const row = this.db.prepare('SELECT * FROM players WHERE token_hash = ?').get(hashToken(token)) as PlayerRow | undefined;
      if (row) {
        this.db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').run(this.now(), row.id);
        return { player: row, token, created: false };
      }
    }
    const newToken = randomBytes(24).toString('base64url');
    const id = `p_${randomBytes(5).toString('hex')}`;
    const name = sanitizeName(requestedName) ?? `Guest-${1000 + (parseInt(id.slice(2, 8), 16) % 9000)}`;
    const t = this.now();
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO players (id, token_hash, name, balance, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, hashToken(newToken), name, this.startingBalance, t, t);
      this.db.prepare('INSERT INTO ledger (player_id, amount, balance_after, kind, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, this.startingBalance, this.startingBalance, 'starting_balance', t);
    });
    return { player: this.get(id)!, token: newToken, created: true };
  }

  get(id: string): PlayerRow | undefined {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined;
  }

  rename(id: string, name: string): string | null {
    const clean = sanitizeName(name);
    if (!clean) return null;
    this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(clean, id);
    return clean;
  }

  savePosition(id: string, p: [number, number, number], heading: number) {
    this.db.prepare('UPDATE players SET pos_x = ?, pos_y = ?, pos_z = ?, heading = ?, last_seen = ? WHERE id = ?')
      .run(p[0], p[1], p[2], heading, this.now(), id);
  }

  static toPublic(row: PlayerRow): PlayerPublic {
    return { id: row.id, name: row.name, color: colorForId(row.id) };
  }

  static toSelf(row: PlayerRow): PlayerSelf {
    return {
      ...PlayerRepo.toPublic(row),
      balance: row.balance,
      lastPosition: row.pos_x != null ? [row.pos_x, row.pos_y ?? 0, row.pos_z ?? 0] : null,
      createdAt: row.created_at,
    };
  }
}
