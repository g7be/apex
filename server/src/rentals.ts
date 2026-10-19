// Authoritative virtual-property rental economy. All amounts are fictional
// in-game currency.
//
// Lease rules (MVP):
// - A lease lasts one term (LEASE_DURATION_HOURS, default 24h real time =
//   "one in-game month") and is paid up front at the building's current rent.
// - Renewing pays one more term and extends from the current expiry. A lease
//   can be prepaid at most 3 terms ahead.
// - Releasing ends the lease immediately, without refund.
// - Expired leases end automatically and the building returns to the market.
// - Each building has at most one active lease (enforced by a unique index),
//   and every rent runs in an IMMEDIATE transaction, so two players can never
//   rent the same building, even across processes sharing the database.
import { colorForId, type Lease } from '@indy/shared';
import { transaction, type Db } from './db.ts';
import type { BuildingCatalog } from './catalog.ts';

export type RentalError =
  | 'unknown_building' | 'not_rentable' | 'already_leased' | 'insufficient_funds' | 'lease_limit'
  | 'not_tenant' | 'renewal_limit' | 'invalid_name' | 'unknown_player';

export const RENTAL_ERROR_TEXT: Record<RentalError, string> = {
  unknown_building: 'That building does not exist in this region.',
  not_rentable: 'This structure cannot be leased.',
  already_leased: 'Someone else already leases this building.',
  insufficient_funds: 'Not enough funds for the first month.',
  lease_limit: 'You have reached the maximum number of leases.',
  not_tenant: 'You do not lease this building.',
  renewal_limit: 'This lease is already prepaid the maximum number of terms ahead.',
  invalid_name: 'Building names must be 2–40 characters.',
  unknown_player: 'Unknown player.',
};

export type RentalResult = { ok: true; lease: Lease; balance: number } | { ok: false; error: RentalError };

interface LeaseRow {
  building_id: string;
  player_id: string;
  player_name: string;
  monthly_rent: number;
  started_at: number;
  expires_at: number;
  custom_name: string | null;
  tile: string | null;
  building_name: string | null;
  cx: number | null;
  cy: number | null;
}

const LEASE_SELECT = `SELECT l.building_id, l.player_id, p.name AS player_name, l.monthly_rent, l.started_at, l.expires_at, l.custom_name,
  l.tile, l.building_name, l.cx, l.cy
  FROM leases l JOIN players p ON p.id = l.player_id`;

const toLease = (r: LeaseRow): Lease => ({
  buildingId: r.building_id,
  playerId: r.player_id,
  playerName: r.player_name,
  playerColor: colorForId(r.player_id),
  monthlyRent: r.monthly_rent,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  customName: r.custom_name,
  buildingName: r.building_name,
  center: r.cx != null && r.cy != null ? [r.cx, r.cy] : null,
  tile: r.tile,
});

class Abort extends Error {
  constructor(public code: RentalError) { super(code); }
}

export interface RentalOptions {
  leaseDurationMs: number;
  maxLeasesPerPlayer: number;
  maxPrepaidTerms?: number;
  now?: () => number;
}

export class RentalService {
  private now: () => number;
  constructor(private db: Db, private catalog: BuildingCatalog, private opts: RentalOptions) {
    this.now = opts.now ?? Date.now;
  }

  activeLeases(): Lease[] {
    return (this.db.prepare(`${LEASE_SELECT} WHERE l.status = 'active' AND l.region = ?`).all(this.catalog.region) as unknown as LeaseRow[]).map(toLease);
  }

  leaseFor(buildingId: string): Lease | null {
    const row = this.db.prepare(`${LEASE_SELECT} WHERE l.status = 'active' AND l.building_id = ?`).get(buildingId) as LeaseRow | undefined;
    return row ? toLease(row) : null;
  }

  leasesOf(playerId: string): Lease[] {
    return (this.db.prepare(`${LEASE_SELECT} WHERE l.status = 'active' AND l.player_id = ?`).all(playerId) as unknown as LeaseRow[]).map(toLease);
  }

  balanceOf(playerId: string): number | undefined {
    return (this.db.prepare('SELECT balance FROM players WHERE id = ?').get(playerId) as { balance: number } | undefined)?.balance;
  }

  private run(fn: () => { lease: Lease; balance: number }): RentalResult {
    try {
      return { ok: true, ...transaction(this.db, fn) };
    } catch (err) {
      if (err instanceof Abort) return { ok: false, error: err.code };
      if (err instanceof Error && /UNIQUE constraint failed: leases\.building_id/.test(err.message)) return { ok: false, error: 'already_leased' };
      throw err;
    }
  }

  private charge(playerId: string, amount: number, kind: string, buildingId: string): number {
    const bal = this.balanceOf(playerId);
    if (bal == null) throw new Abort('unknown_player');
    if (bal < amount) throw new Abort('insufficient_funds');
    const after = bal - amount;
    this.db.prepare('UPDATE players SET balance = ? WHERE id = ?').run(after, playerId);
    this.db.prepare('INSERT INTO ledger (player_id, amount, balance_after, kind, building_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(playerId, -amount, after, kind, buildingId, this.now());
    return after;
  }

  rent(playerId: string, buildingId: string, tileRef?: string): RentalResult {
    const entry = this.catalog.get(buildingId, tileRef);
    if (!entry) return { ok: false, error: 'unknown_building' };
    if (!entry.profile.rentable) return { ok: false, error: 'not_rentable' };
    return this.run(() => {
      const t = this.now();
      this.expireBuilding(buildingId, t);
      if (this.db.prepare(`SELECT 1 FROM leases WHERE building_id = ? AND status = 'active'`).get(buildingId)) throw new Abort('already_leased');
      const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM leases WHERE player_id = ? AND status = 'active'`).get(playerId) as { n: number }).n;
      if (count >= this.opts.maxLeasesPerPlayer) throw new Abort('lease_limit');
      const price = entry.profile.monthlyRent;
      const balance = this.charge(playerId, price, 'rent', buildingId);
      this.db.prepare('INSERT INTO leases (region, building_id, player_id, monthly_rent, started_at, expires_at, tile, building_name, cx, cy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.catalog.region, buildingId, playerId, price, t, t + this.opts.leaseDurationMs,
          entry.tile, entry.profile.displayName, entry.record.centroid[0], entry.record.centroid[1]);
      return { lease: this.leaseFor(buildingId)!, balance };
    });
  }

  renew(playerId: string, buildingId: string, tileRef?: string): RentalResult {
    // A leased building is found via the tile stored with its lease.
    const entry = this.catalog.get(buildingId, tileRef ?? this.leaseFor(buildingId)?.tile ?? undefined);
    if (!entry) return { ok: false, error: 'unknown_building' };
    return this.run(() => {
      const t = this.now();
      this.expireBuilding(buildingId, t);
      const lease = this.leaseFor(buildingId);
      if (!lease || lease.playerId !== playerId) throw new Abort('not_tenant');
      const maxAhead = (this.opts.maxPrepaidTerms ?? 3) * this.opts.leaseDurationMs;
      const newExpiry = Math.max(t, lease.expiresAt) + this.opts.leaseDurationMs;
      if (newExpiry - t > maxAhead) throw new Abort('renewal_limit');
      const price = entry.profile.monthlyRent;
      const balance = this.charge(playerId, price, 'renew', buildingId);
      this.db.prepare(`UPDATE leases SET expires_at = ?, monthly_rent = ? WHERE building_id = ? AND status = 'active'`).run(newExpiry, price, buildingId);
      return { lease: this.leaseFor(buildingId)!, balance };
    });
  }

  release(playerId: string, buildingId: string): RentalResult {
    return this.run(() => {
      const lease = this.leaseFor(buildingId);
      if (!lease || lease.playerId !== playerId) throw new Abort('not_tenant');
      this.db.prepare(`UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'released' WHERE building_id = ? AND status = 'active'`)
        .run(this.now(), buildingId);
      return { lease, balance: this.balanceOf(playerId)! };
    });
  }

  rename(playerId: string, buildingId: string, name: string): RentalResult {
    const clean = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _.,&'\-]/gu, '').trim().slice(0, 40) : '';
    return this.run(() => {
      const lease = this.leaseFor(buildingId);
      if (!lease || lease.playerId !== playerId) throw new Abort('not_tenant');
      if (clean.length === 1) throw new Abort('invalid_name');
      this.db.prepare(`UPDATE leases SET custom_name = ? WHERE building_id = ? AND status = 'active'`).run(clean || null, buildingId);
      return { lease: this.leaseFor(buildingId)!, balance: this.balanceOf(playerId)! };
    });
  }

  private expireBuilding(buildingId: string, t: number) {
    this.db.prepare(`UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'expired' WHERE building_id = ? AND status = 'active' AND expires_at <= ?`)
      .run(t, buildingId, t);
  }

  /** End all leases past their expiry; returns the affected building ids. */
  expireDue(): string[] {
    const t = this.now();
    return transaction(this.db, () => {
      const rows = this.db.prepare(`SELECT building_id FROM leases WHERE status = 'active' AND expires_at <= ?`).all(t) as { building_id: string }[];
      if (rows.length) {
        this.db.prepare(`UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'expired' WHERE status = 'active' AND expires_at <= ?`).run(t, t);
      }
      return rows.map((r) => r.building_id);
    });
  }
}
