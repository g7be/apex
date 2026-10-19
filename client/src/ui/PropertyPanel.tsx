import { useEffect, useMemo, useState } from 'react';
import { CIRCULATION_KINDS, polygonArea, principalAngle, rotateRing, centroid, bounds, type Vec2 } from '@indy/shared';
import { game, useGame } from '../state/store.ts';
import { getBuilding } from '../world/worldData.ts';
import { area, dateTime, duration, money } from './format.ts';
import { focusBuilding, interiorFor, openFloorPlan } from '../game/actions.ts';

export function FootprintSvg({ fp, holes, size = 120, color = '#4fd1ff', align = true }: { fp: Vec2[]; holes?: Vec2[][]; size?: number; color?: string; align?: boolean }) {
  const { path, view } = useMemo(() => {
    // North-up by default; optionally aligned to the building's main axis.
    const ang = align ? 0 : principalAngle(fp);
    const c = centroid(fp);
    const rings = [fp, ...(holes ?? [])].map((r) => rotateRing(r, ang, c));
    const bb = bounds(rings[0]);
    const s = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) || 1;
    const pad = s * 0.08;
    const d = rings.map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${(p[0] - bb.minX + pad).toFixed(2)},${(bb.maxY - p[1] + pad).toFixed(2)}`).join('') + 'Z').join('');
    return { path: d, view: `0 0 ${(bb.maxX - bb.minX + 2 * pad).toFixed(2)} ${(bb.maxY - bb.minY + 2 * pad).toFixed(2)}` };
  }, [fp, holes, align]);
  return (
    <svg className="footprint" viewBox={view} width={size} height={size} preserveAspectRatio="xMidYMid meet">
      <path d={path} fill={`${color}33`} stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" fillRule="evenodd" />
    </svg>
  );
}

function useNow(interval = 15000) {
  const [now, setNow] = useState(() => game.serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(game.serverNow()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

export function PropertyPanel() {
  const id = useGame((s) => s.selectedId);
  const lease = useGame((s) => (s.selectedId ? s.leases[s.selectedId] : undefined));
  const me = useGame((s) => s.me);
  const config = useGame((s) => s.config);
  const dataVersion = useGame((s) => s.dataVersion);
  const now = useNow();
  const [unit, setUnit] = useState<'ft2' | 'm2'>('ft2');

  const info = useMemo(() => {
    if (!id) return null;
    const b = getBuilding(id);
    if (!b) return null;
    const inter = interiorFor(id);
    const g = inter?.getFloor(0);
    return { b, rooms: inter?.roomCount ?? 0, groundRooms: g ? g.rooms.filter((r) => !CIRCULATION_KINDS.has(r.kind)).length : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dataVersion]);

  if (!id) return null;
  if (!info) {
    return (
      <aside className="panel property-panel">
        <div className="panel-loading">Loading building data…</div>
      </aside>
    );
  }
  const { b } = info;
  const p = b.profile;
  const t = b.record.tags;
  const mine = !!lease && lease.playerId === me?.id;
  const status = !p.rentable ? 'unavailable' : lease ? (mine ? 'mine' : 'leased') : 'available';
  const fpArea = polygonArea(b.record.fp);
  const title = lease?.customName ?? p.displayName;
  const subtitle = lease?.customName ? p.displayName : b.record.name && b.record.address ? b.record.address : b.record.street ? b.record.street : null;
  const leaseMonths = config ? `${Math.round(config.leaseDurationMs / 3_600_000)}h real time` : '';

  return (
    <aside className="panel property-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="pp-header">
        <div>
          <div className={`badge cls-${p.cls}`}>{p.clsLabel}</div>
          <h2 title={title}>{title}</h2>
          {subtitle && <div className="pp-sub">{subtitle}</div>}
        </div>
        <button className="icon-btn" onClick={() => game.set({ selectedId: null })} title="Close (Esc)">✕</button>
      </header>

      <div className="pp-hero">
        <FootprintSvg fp={b.record.fp} holes={b.record.holes} size={112} color={status === 'mine' ? '#3ddc84' : status === 'leased' ? lease!.playerColor : '#4fd1ff'} />
        <div className="pp-status">
          <div className={`status status-${status}`}>
            {status === 'available' && 'Available'}
            {status === 'mine' && 'Leased by you'}
            {status === 'leased' && 'Leased'}
            {status === 'unavailable' && 'Not leasable'}
          </div>
          <div className="pp-price">
            {money(lease?.monthlyRent ?? p.monthlyRent)}<span>/month</span>
          </div>
          <div className="pp-price-note">In-game currency · 1 month = {leaseMonths}</div>
        </div>
      </div>

      {lease && (
        <div className="pp-lease">
          <div className="row"><span>Tenant</span><b><i className="dot" style={{ background: mine ? '#3ddc84' : lease.playerColor }} />{lease.playerName}{mine ? ' (you)' : ''}</b></div>
          <div className="row"><span>Lease expires</span><b>{dateTime(lease.expiresAt)} · {duration(lease.expiresAt - now)} left</b></div>
          <div className="row"><span>Leased since</span><b>{dateTime(lease.startedAt)}</b></div>
        </div>
      )}

      <div className="pp-grid">
        <div><span>Footprint</span><b>{area(fpArea, unit)}</b></div>
        <div><span>Floor area</span><b>{area(p.grossFloorArea, unit)}</b></div>
        <div><span>Floors</span><b>{p.floors}</b></div>
        <div><span>Height</span><b>{Math.round(p.height)} m</b></div>
        <div><span>Rooms</span><b>{info.rooms.toLocaleString()}</b></div>
        <div><span>Roof</span><b className="cap">{p.roofShape}</b></div>
      </div>
      <div className="pp-meta">
        <button className="link" onClick={() => setUnit(unit === 'ft2' ? 'm2' : 'ft2')}>Show {unit === 'ft2' ? 'm²' : 'sq ft'}</button>
        <span title="Where the height and floor count come from">
          {p.heightSource === 'estimated' ? 'Height estimated (no OSM data)' : `Height from ${p.heightSource.replace('osm:', 'OSM ')}`}
        </span>
        {p.yearBuilt && <span>Built {p.yearBuilt}</span>}
        {t.architect && <span>Architect: {t.architect}</span>}
      </div>

      <div className="pp-actions">
        <button className="btn ghost" onClick={() => openFloorPlan(id)}>View rooms</button>
        <button className="btn ghost" onClick={() => focusBuilding(id)}>Zoom to building</button>
        {status === 'available' && (
          <button className="btn primary wide" disabled={!me} onClick={() => game.set({ dialog: { kind: 'rent', buildingId: id } })}>
            Rent building · {money(p.monthlyRent)}
          </button>
        )}
        {status === 'mine' && (
          <>
            <button className="btn primary" onClick={() => game.set({ dialog: { kind: 'renew', buildingId: id } })}>Renew lease</button>
            <button className="btn ghost" onClick={() => game.set({ dialog: { kind: 'rename', buildingId: id } })}>Rename</button>
            <button className="btn danger" onClick={() => game.set({ dialog: { kind: 'release', buildingId: id } })}>End lease</button>
          </>
        )}
        {status === 'leased' && <div className="pp-note">This building is leased by another player. It returns to the market when the lease expires.</div>}
      </div>

      <footer className="pp-footer">
        <a href={`https://www.openstreetmap.org/${b.record.osm}`} target="_blank" rel="noreferrer">OSM {b.record.osm}</a>
        <span>Footprint: real OpenStreetMap geometry · Interiors &amp; rents: fictional</span>
      </footer>
    </aside>
  );
}
