import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { PlayerRepo } from '../src/players.ts';
import { RentalService } from '../src/rentals.ts';
import { fakeCatalog, tempDir } from './helpers.ts';

const HOUR = 3_600_000;

describe('rental transactions', () => {
  let tmp: ReturnType<typeof tempDir>;
  let db: Db;
  let clock: number;
  let players: PlayerRepo;
  let rentals: RentalService;
  const catalog = fakeCatalog();

  beforeEach(() => {
    tmp = tempDir();
    db = openDb(tmp.db);
    clock = 1_700_000_000_000;
    players = new PlayerRepo(db, 25_000, () => clock);
    rentals = new RentalService(db, catalog, { leaseDurationMs: 24 * HOUR, maxLeasesPerPlayer: 3, now: () => clock });
  });
  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it('charges the authoritative catalog price and creates a lease', () => {
    const { player } = players.login(undefined, 'Alice');
    const price = catalog.get('osm:w1')!.profile.monthlyRent;
    const res = rentals.rent(player.id, 'osm:w1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.balance).toBe(25_000 - price);
    expect(res.lease.monthlyRent).toBe(price);
    expect(res.lease.expiresAt).toBe(clock + 24 * HOUR);
    expect(rentals.balanceOf(player.id)).toBe(25_000 - price);
    const ledger = db.prepare('SELECT amount, kind FROM ledger WHERE player_id = ? ORDER BY id').all(player.id);
    expect(ledger).toEqual([{ amount: 25_000, kind: 'starting_balance' }, { amount: -price, kind: 'rent' }]);
  });

  it('prevents two players from leasing the same building', () => {
    const a = players.login(undefined, 'Alice').player;
    const b = players.login(undefined, 'Bob').player;
    expect(rentals.rent(a.id, 'osm:w2').ok).toBe(true);
    const second = rentals.rent(b.id, 'osm:w2');
    expect(second).toEqual({ ok: false, error: 'already_leased' });
    expect(rentals.balanceOf(b.id)).toBe(25_000);
  });

  it('enforces one active lease per building at the database level', () => {
    const a = players.login(undefined, 'Alice').player;
    rentals.rent(a.id, 'osm:w1');
    expect(() => db.prepare(`INSERT INTO leases (region, building_id, player_id, monthly_rent, started_at, expires_at) VALUES ('x', 'osm:w1', ?, 1, 0, 1)`).run(a.id))
      .toThrow(/UNIQUE/);
  });

  it('rejects rentals the player cannot afford, without side effects', () => {
    const poor = new PlayerRepo(db, 100, () => clock).login(undefined, 'Poor').player;
    expect(rentals.rent(poor.id, 'osm:w3')).toEqual({ ok: false, error: 'insufficient_funds' });
    expect(rentals.balanceOf(poor.id)).toBe(100);
    expect(rentals.leaseFor('osm:w3')).toBeNull();
  });

  it('rejects unknown and non-rentable buildings', () => {
    const a = players.login(undefined, 'Alice').player;
    expect(rentals.rent(a.id, 'osm:w999')).toEqual({ ok: false, error: 'unknown_building' });
    expect(rentals.rent(a.id, 'osm:w4')).toEqual({ ok: false, error: 'not_rentable' });
  });

  it('enforces the per-player lease limit', () => {
    const rich = new PlayerRepo(db, 10_000_000, () => clock).login(undefined, 'Rich').player;
    const limited = new RentalService(db, catalog, { leaseDurationMs: HOUR, maxLeasesPerPlayer: 2, now: () => clock });
    expect(limited.rent(rich.id, 'osm:w1').ok).toBe(true);
    expect(limited.rent(rich.id, 'osm:w2').ok).toBe(true);
    expect(limited.rent(rich.id, 'osm:w3')).toEqual({ ok: false, error: 'lease_limit' });
  });

  it('expires leases and returns the building to the market', () => {
    const a = players.login(undefined, 'Alice').player;
    const b = players.login(undefined, 'Bob').player;
    rentals.rent(a.id, 'osm:w1');
    clock += 23 * HOUR;
    expect(rentals.expireDue()).toEqual([]);
    clock += 2 * HOUR;
    expect(rentals.expireDue()).toEqual(['osm:w1']);
    expect(rentals.leaseFor('osm:w1')).toBeNull();
    expect(rentals.rent(b.id, 'osm:w1').ok).toBe(true);
  });

  it('lets another player rent an expired building even before the sweep runs', () => {
    const a = players.login(undefined, 'Alice').player;
    const b = players.login(undefined, 'Bob').player;
    rentals.rent(a.id, 'osm:w1');
    clock += 25 * HOUR;
    const res = rentals.rent(b.id, 'osm:w1');
    expect(res.ok && res.lease.playerId).toBe(b.id);
  });

  it('renews from the current expiry, charges again, and caps prepaid terms', () => {
    const a = players.login(undefined, 'Alice').player;
    const first = rentals.rent(a.id, 'osm:w1');
    if (!first.ok) throw new Error('rent failed');
    const price = first.lease.monthlyRent;
    const r1 = rentals.renew(a.id, 'osm:w1');
    expect(r1.ok && r1.lease.expiresAt).toBe(first.lease.expiresAt + 24 * HOUR);
    expect(r1.ok && r1.balance).toBe(25_000 - 2 * price);
    expect(rentals.renew(a.id, 'osm:w1').ok).toBe(true);
    expect(rentals.renew(a.id, 'osm:w1')).toEqual({ ok: false, error: 'renewal_limit' });
  });

  it('only the tenant can renew, release or rename', () => {
    const a = players.login(undefined, 'Alice').player;
    const b = players.login(undefined, 'Bob').player;
    rentals.rent(a.id, 'osm:w2');
    expect(rentals.renew(b.id, 'osm:w2')).toEqual({ ok: false, error: 'not_tenant' });
    expect(rentals.release(b.id, 'osm:w2')).toEqual({ ok: false, error: 'not_tenant' });
    expect(rentals.rename(b.id, 'osm:w2', 'Mine now')).toEqual({ ok: false, error: 'not_tenant' });
    const named = rentals.rename(a.id, 'osm:w2', 'Alice HQ');
    expect(named.ok && named.lease.customName).toBe('Alice HQ');
    expect(rentals.release(a.id, 'osm:w2').ok).toBe(true);
    expect(rentals.leaseFor('osm:w2')).toBeNull();
  });

  it('persists leases, balances and identities across database reopen', () => {
    const { player, token } = players.login(undefined, 'Alice');
    rentals.rent(player.id, 'osm:w2');
    const balance = rentals.balanceOf(player.id);
    players.savePosition(player.id, [10, 0, 20], 1.5);
    db.close();

    db = openDb(tmp.db);
    players = new PlayerRepo(db, 25_000, () => clock);
    rentals = new RentalService(db, catalog, { leaseDurationMs: 24 * HOUR, maxLeasesPerPlayer: 3, now: () => clock });
    const again = players.login(token);
    expect(again.created).toBe(false);
    expect(again.player.id).toBe(player.id);
    expect(again.player.balance).toBe(balance);
    expect([again.player.pos_x, again.player.pos_z]).toEqual([10, 20]);
    expect(rentals.leaseFor('osm:w2')?.playerId).toBe(player.id);
    expect(rentals.activeLeases()).toHaveLength(1);
  });

  it('creates a new guest for unknown tokens and never stores raw tokens', () => {
    const { token } = players.login(undefined, 'Alice');
    expect(players.login('x'.repeat(32)).created).toBe(true);
    const rows = db.prepare('SELECT token_hash FROM players').all() as { token_hash: string }[];
    expect(rows.every((r) => r.token_hash !== token && r.token_hash.length === 64)).toBe(true);
  });
});
