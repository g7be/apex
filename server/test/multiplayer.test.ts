// End-to-end multiplayer tests against a real server instance over WebSockets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/app.ts';
import { TestClient, fakeCatalog, tempDir, testConfig } from './helpers.ts';

describe('multiplayer server', () => {
  let tmp: ReturnType<typeof tempDir>;
  let server: RunningServer;
  const clients: TestClient[] = [];
  const client = () => {
    const c = new TestClient(server.port);
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    tmp = tempDir();
    server = await startServer(testConfig(tmp.db), { catalog: fakeCatalog() });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
    tmp.cleanup();
  });

  it('issues persistent guest identities with a starting balance', async () => {
    const a = client();
    const w = await a.hello(undefined, 'Alice');
    expect(w.you.name).toBe('Alice');
    expect(w.you.balance).toBe(25_000);
    expect(w.token.length).toBeGreaterThan(20);
    a.close();
    const again = client();
    const w2 = await again.hello(w.token);
    expect(w2.you.id).toBe(w.you.id);
  });

  it('shows players to each other and relays movement', async () => {
    const a = client(), b = client();
    const wa = await a.hello(undefined, 'Alice');
    const wb = await b.hello(undefined, 'Bob');
    expect(wb.players.map((p) => p.id)).toContain(wa.you.id);
    await a.wait('join', (m) => m.player.id === wb.you.id);
    a.send({ t: 'state', p: [12, 0, 34], ry: 1, anim: 'walk', in: null });
    const st = await b.wait('players', (m) => m.states.some((s) => s.id === wa.you.id));
    expect(st.states.find((s) => s.id === wa.you.id)?.p).toEqual([12, 0, 34]);
    a.close();
    await b.wait('leave', (m) => m.id === wa.you.id);
  });

  it('broadcasts rentals and balance changes', async () => {
    const a = client(), b = client();
    const wa = await a.hello(undefined, 'Alice');
    await b.hello(undefined, 'Bob');
    const res = await a.request('rent', 'osm:w2');
    expect(res.ok).toBe(true);
    const bal = await a.wait('balance');
    expect(bal.balance).toBe(25_000 - res.lease!.monthlyRent);
    const seen = await b.wait('lease', (m) => m.buildingId === 'osm:w2');
    expect(seen.lease?.playerId).toBe(wa.you.id);
    expect(seen.reason).toBe('rented');
    const denied = await b.request('rent', 'osm:w2');
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/already leases/);
  });

  it('lets exactly one of two simultaneous renters win', async () => {
    const a = client(), b = client();
    await a.hello(undefined, 'Alice');
    await b.hello(undefined, 'Bob');
    const [ra, rb] = await Promise.all([a.request('rent', 'osm:w2'), b.request('rent', 'osm:w2')]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(server.rentals.activeLeases()).toHaveLength(1);
  });

  it('ignores client-supplied prices and keeps leased interiors private', async () => {
    const a = client(), b = client();
    await a.hello(undefined, 'Alice');
    const wb = await b.hello(undefined, 'Bob');
    a.send({ t: 'rent', req: 77, buildingId: 'osm:w1', price: 1, balance: 9e9 });
    const r = await a.wait('result', (m) => m.req === 77);
    expect(r.lease?.monthlyRent).toBe(server.catalog.get('osm:w1')!.profile.monthlyRent);
    b.send({ t: 'state', p: [5, 0, 5], ry: 0, anim: 'idle', in: { b: 'osm:w1', f: 0 } });
    const st = await a.wait('players', (m) => m.states.some((s) => s.id === wb.you.id));
    expect(st.states.find((s) => s.id === wb.you.id)?.in).toBeNull();
  });

  it('keeps leases and progress after a server restart', async () => {
    const a = client();
    const w = await a.hello(undefined, 'Alice');
    const res = await a.request('rent', 'osm:w2');
    a.send({ t: 'state', p: [42, 0, -17], ry: 0.5, anim: 'idle', in: null });
    await new Promise((r) => setTimeout(r, 250));
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.close();

    server = await startServer(testConfig(tmp.db), { catalog: fakeCatalog() });
    const back = client();
    const w2 = await back.hello(w.token);
    expect(w2.you.id).toBe(w.you.id);
    expect(w2.you.balance).toBe(25_000 - res.lease!.monthlyRent);
    expect(w2.you.lastPosition).toEqual([42, 0, -17]);
    expect(w2.leases.map((l) => l.buildingId)).toEqual(['osm:w2']);
  });

  it('relays global and nearby chat', async () => {
    const a = client(), b = client(), c = client();
    await a.hello(undefined, 'Alice');
    await b.hello(undefined, 'Bob');
    await c.hello(undefined, 'Carol');
    a.send({ t: 'state', p: [0, 0, 0], ry: 0, anim: 'idle', in: null });
    b.send({ t: 'state', p: [20, 0, 0], ry: 0, anim: 'idle', in: null });
    c.send({ t: 'state', p: [900, 0, 0], ry: 0, anim: 'idle', in: null });
    await new Promise((r) => setTimeout(r, 200));
    a.send({ t: 'chat', text: 'hello downtown', channel: 'global' });
    expect((await c.wait('chat')).text).toBe('hello downtown');
    a.send({ t: 'chat', text: 'psst', channel: 'local' });
    expect((await b.wait('chat', (m) => m.text === 'psst')).channel).toBe('local');
    await new Promise((r) => setTimeout(r, 200));
    expect(c.messages.some((m) => m.t === 'chat' && m.text === 'psst')).toBe(false);
  });
});
