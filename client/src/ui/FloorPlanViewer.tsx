// Interactive floor-plan inspector. Plans are drawn in each building's own
// "plan frame" (rotated so the main axis is horizontal); a north arrow shows
// the real orientation. Layouts are fictional, generated from the footprint.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CIRCULATION_KINDS, ROOM_KIND_LABELS, bounds, principalAngle, rotatePoint, rotateRing, type Floor, type Room, type Vec2,
} from '@indy/shared';
import { game, useGame } from '../state/store.ts';
import { getBuilding } from '../world/worldData.ts';
import { interiorFor } from '../game/actions.ts';
import { ROOM_COLORS } from './roomColors.ts';
import { area as fmtArea, money } from './format.ts';
import { BuildingPreview } from './BuildingPreview.tsx';

function roomDims(room: Room) {
  const ang = principalAngle(room.poly);
  const r = rotateRing(room.poly, ang, room.label);
  const bb = bounds(r);
  return [bb.maxX - bb.minX, bb.maxY - bb.minY] as const;
}

const short = (room: Room) => (room.unit ? room.name.split(' · ').pop()! : room.name);

export function FloorPlanViewer() {
  const id = useGame((s) => s.floorPlanFor);
  const lease = useGame((s) => (s.floorPlanFor ? s.leases[s.floorPlanFor] : undefined));
  const [floorIdx, setFloorIdx] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [unit, setUnit] = useState<'ft2' | 'm2'>('ft2');
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const b = id ? getBuilding(id) : undefined;
  const interior = useMemo(() => (id ? interiorFor(id) : null), [id]);

  useEffect(() => {
    setFloorIdx(0);
    setSelected(null);
    setView(null);
  }, [id]);

  const floor: Floor | null = useMemo(() => (interior ? interior.getFloor(floorIdx) : null), [interior, floorIdx]);

  const plan = useMemo(() => {
    if (!b || !interior || !floor) return null;
    const toPlan = (p: Vec2): Vec2 => {
      const q = rotatePoint(p, interior.planAngle, interior.planCenter);
      return [q[0], -q[1]];
    };
    const fp = b.record.fp.map(toPlan);
    const holes = (b.record.holes ?? []).map((h) => h.map(toPlan));
    const bb = bounds(fp);
    const pad = Math.max(3, (bb.maxX - bb.minX) * 0.06);
    const rooms = floor.rooms.map((r) => ({
      room: r,
      pts: r.poly.map(toPlan),
      holes: (r.holes ?? []).map((h) => h.map(toPlan)),
      label: toPlan(r.label),
      dims: roomDims(r),
    }));
    const doors = floor.doors.map((d) => {
      const p = toPlan(d.pos);
      const q = toPlan([d.pos[0] + d.dir[0], d.pos[1] + d.dir[1]]);
      const dir: Vec2 = [q[0] - p[0], q[1] - p[1]];
      return { d, p, dir };
    });
    const north = toPlan([interior.planCenter[0], interior.planCenter[1] + 1]);
    const c = toPlan(interior.planCenter);
    return {
      fp, holes, rooms, doors,
      box: { x: bb.minX - pad, y: bb.minY - pad, w: bb.maxX - bb.minX + 2 * pad, h: bb.maxY - bb.minY + 2 * pad },
      northAngle: (Math.atan2(north[0] - c[0], -(north[1] - c[1])) * 180) / Math.PI,
      size: Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY),
    };
  }, [b, interior, floor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!id) return;
      if (e.key === 'Escape') game.set({ floorPlanFor: null });
      if (e.key === 'ArrowUp' || e.key === 'PageUp') setFloorIdx((f) => Math.min((interior?.floorCount ?? 1) - 1, f + 1));
      if (e.key === 'ArrowDown' || e.key === 'PageDown') setFloorIdx((f) => Math.max(0, f - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, interior]);

  if (!id || !b || !interior || !floor || !plan) return null;
  const vb = view ?? plan.box;
  const sel = plan.rooms.find((r) => r.room.id === (selected ?? hover));
  const realRooms = floor.rooms.filter((r) => !CIRCULATION_KINDS.has(r.kind));
  const kinds = [...new Set(floor.rooms.map((r) => r.kind))];
  const floorArea = floor.rooms.reduce((s, r) => s + r.area, 0);
  const unitRooms = sel?.room.unit ? floor.rooms.filter((r) => r.unit === sel.room.unit) : null;

  const onWheel = (e: React.WheelEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const mx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
    const my = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
    const w = Math.min(plan.box.w * 2, Math.max(plan.box.w / 12, vb.w * k));
    const h = (w / vb.w) * vb.h;
    setView({ x: mx - ((mx - vb.x) * w) / vb.w, y: my - ((my - vb.y) * h) / vb.h, w, h });
  };
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, svg = svgRef.current;
    if (!d || !svg || !(e.buttons & 1)) return;
    const rect = svg.getBoundingClientRect();
    const s = Math.max(vb.w / rect.width, vb.h / rect.height);
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) setView({ ...vb, x: d.vx - (e.clientX - d.x) * s, y: d.vy - (e.clientY - d.y) * s });
  };
  const onUp = () => { drag.current = null; };

  const wallW = Math.max(0.18, plan.size / 260);
  // Scale bar: a round length about a fifth of the visible width.
  const scaleM = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((m) => m >= vb.w / 6) ?? 500;
  const n = interior.floorCount;
  const floorButtons = n <= 14 ? Array.from({ length: n }, (_, i) => i) : [0, 1, 2, ...(floorIdx > 2 && floorIdx < n - 3 ? [floorIdx] : []), n - 3, n - 2, n - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) game.set({ floorPlanFor: null }); }}>
      <div className="fpv" role="dialog" aria-label="Floor plan viewer">
        <header className="fpv-header">
          <div>
            <div className="fpv-kicker">Floor plan · {b.profile.clsLabel}{lease ? ` · leased by ${lease.playerName}` : ''}</div>
            <h2>{lease?.customName ?? b.profile.displayName}</h2>
          </div>
          <div className="fpv-header-right">
            <span className="pill warn" title="Interiors are invented by the game from the real exterior footprint.">Fictional layout · generated from real footprint</span>
            <button className="btn ghost small" onClick={() => setUnit(unit === 'ft2' ? 'm2' : 'ft2')}>{unit === 'ft2' ? 'sq ft' : 'm²'}</button>
            <button className="icon-btn" onClick={() => game.set({ floorPlanFor: null })} title="Close (Esc)">✕</button>
          </div>
        </header>

        <div className="fpv-body">
          <section className="fpv-left">
            <div className="fpv-preview">
              <BuildingPreview record={b.record} profile={b.profile} floor={floor} />
            </div>
            <div className="fpv-stats">
              <div><span>Floors</span><b>{n}</b></div>
              <div><span>Total rooms</span><b>{interior.roomCount.toLocaleString()}</b></div>
              <div><span>This floor</span><b>{realRooms.length} rooms</b></div>
              <div><span>Floor area</span><b>{fmtArea(floorArea, unit)}</b></div>
              <div><span>Rent</span><b>{money(lease?.monthlyRent ?? b.profile.monthlyRent)}/mo</b></div>
              <div><span>Ceiling</span><b>{floor.height.toFixed(1)} m</b></div>
            </div>
            <div className="fpv-legend">
              {kinds.map((k) => (
                <span key={k}><i style={{ background: ROOM_COLORS[k] }} />{ROOM_KIND_LABELS[k]}</span>
              ))}
            </div>
          </section>

          <section className="fpv-center">
            <div className="floor-tabs">
              <button className="tab-step" disabled={floorIdx === 0} onClick={() => setFloorIdx(floorIdx - 1)}>‹</button>
              {floorButtons.map((i, k) => (
                <span key={i} className="tab-wrap">
                  {k > 0 && i - floorButtons[k - 1] > 1 && <span className="tab-gap">…</span>}
                  <button className={i === floorIdx ? 'active' : ''} onClick={() => { setFloorIdx(i); setSelected(null); }}>
                    {i === 0 ? 'Floor 1 · Ground' : `Floor ${i + 1}`}
                  </button>
                </span>
              ))}
              <button className="tab-step" disabled={floorIdx >= n - 1} onClick={() => setFloorIdx(floorIdx + 1)}>›</button>
            </div>
            <div className="plan-wrap">
              <svg
                ref={svgRef}
                className="plan"
                viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
                preserveAspectRatio="xMidYMid meet"
                onWheel={onWheel}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
              >
                <defs>
                  <pattern id="hatch" width="0.8" height="0.8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="0.8" stroke="#0005" strokeWidth="0.25" />
                  </pattern>
                </defs>
                <path
                  d={[plan.fp, ...plan.holes].map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('') + 'Z').join('')}
                  fill="#0f141c" fillRule="evenodd"
                />
                {plan.rooms.map(({ room, pts, holes }) => {
                  const active = room.id === hover || room.id === selected;
                  const d = [pts, ...holes].map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('') + 'Z').join('');
                  return (
                    <g key={room.id}>
                      <path
                        d={d}
                        fillRule="evenodd"
                        fill={ROOM_COLORS[room.kind]}
                        fillOpacity={active ? 1 : room.kind === 'corridor' ? 0.55 : 0.8}
                        stroke={room.id === selected ? '#ffffff' : '#141a22'}
                        strokeWidth={room.id === selected ? wallW * 1.6 : wallW * 0.6}
                        strokeLinejoin="round"
                        className="plan-room"
                        onPointerEnter={() => setHover(room.id)}
                        onPointerLeave={() => setHover((h) => (h === room.id ? null : h))}
                        onClick={() => setSelected(room.id === selected ? null : room.id)}
                      />
                      {(room.kind === 'stair' || room.kind === 'elevator') && <path d={d} fill="url(#hatch)" pointerEvents="none" />}
                    </g>
                  );
                })}
                {plan.doors.map(({ d, p, dir }, i) => {
                  const hw = d.width / 2;
                  const a: Vec2 = [p[0] - dir[0] * hw, p[1] - dir[1] * hw];
                  const c: Vec2 = [p[0] + dir[0] * hw, p[1] + dir[1] * hw];
                  const nrm: Vec2 = [-dir[1], dir[0]];
                  const swing: Vec2 = [a[0] + nrm[0] * d.width, a[1] + nrm[1] * d.width];
                  return (
                    <g key={i} pointerEvents="none">
                      <line x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke={d.exterior ? '#4fd1ff' : '#f4f1ea'} strokeWidth={wallW * 1.4} />
                      {!d.exterior && d.width < 1.2 && (
                        <path d={`M${c[0]},${c[1]} A${d.width},${d.width} 0 0 0 ${swing[0]},${swing[1]} L${a[0]},${a[1]}`} fill="none" stroke="#1d2530" strokeWidth={wallW * 0.35} strokeOpacity={0.7} />
                      )}
                    </g>
                  );
                })}
                <path
                  d={[plan.fp, ...plan.holes].map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('') + 'Z').join('')}
                  fill="none" stroke="#0b0f15" strokeWidth={wallW * 2.2} strokeLinejoin="round" pointerEvents="none"
                />
                {plan.doors.filter(({ d }) => d.exterior).map(({ p }, i) => (
                  <g key={`e${i}`} pointerEvents="none">
                    <circle cx={p[0]} cy={p[1]} r={Math.max(0.6, plan.size / 70)} fill="#4fd1ff" stroke="#0b0f15" strokeWidth={wallW * 0.5} />
                  </g>
                ))}
                {plan.rooms.map(({ room, label, dims }) => {
                  if (room.area < 7 || room.kind === 'corridor') return null;
                  const fs = Math.max(plan.size / 140, Math.min(Math.sqrt(room.area) * 0.16, plan.size / 30));
                  const name = short(room);
                  const maxChars = Math.floor(Math.max(dims[0], dims[1]) / (fs * 0.58));
                  if (maxChars < 4) return null;
                  return (
                    <g key={`l-${room.id}`} pointerEvents="none" className="plan-label">
                      <text x={label[0]} y={label[1] - fs * 0.15} fontSize={fs} textAnchor="middle">
                        {name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name}
                      </text>
                      <text x={label[0]} y={label[1] + fs * 1.05} fontSize={fs * 0.78} textAnchor="middle" className="sub">
                        {fmtArea(room.area, unit)}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="plan-overlay">
                <div className="north" style={{ transform: `rotate(${plan.northAngle}deg)` }} title="North">
                  <span>N</span>▲
                </div>
                <div className="scalebar">
                  <div style={{ width: `${(scaleM / vb.w) * 100}%` }} />
                  <span>{scaleM} m</span>
                </div>
                <div className="plan-help">Scroll to zoom · drag to pan · click a room</div>
                {view && <button className="btn ghost small reset" onClick={() => setView(null)}>Reset view</button>}
              </div>
              {floor.fallback && <div className="plan-note">This footprint could not be partitioned cleanly, so this floor uses an open-plan fallback.</div>}
            </div>
          </section>

          <section className="fpv-right">
            {sel ? (
              <div className="room-detail">
                <div className="room-kind" style={{ background: ROOM_COLORS[sel.room.kind] }}>{ROOM_KIND_LABELS[sel.room.kind]}</div>
                <h3>{sel.room.name}</h3>
                {sel.room.number && <div className="room-num">Room {sel.room.number}</div>}
                <div className="rd-grid">
                  <div><span>Area</span><b>{fmtArea(sel.room.area, 'ft2')}</b></div>
                  <div><span>Metric</span><b>{fmtArea(sel.room.area, 'm2')}</b></div>
                  <div><span>Approx. size</span><b>{sel.dims[0].toFixed(1)} × {sel.dims[1].toFixed(1)} m</b></div>
                  <div><span>Floor</span><b>{floor.index + 1}</b></div>
                  <div><span>Doors</span><b>{floor.doors.filter((d) => d.rooms.includes(sel.room.id)).length}</b></div>
                  <div><span>Shape</span><b>{sel.room.poly.length === 4 ? 'Rectangular' : `${sel.room.poly.length}-sided`}</b></div>
                </div>
                {unitRooms && (
                  <div className="unit-box">
                    <div className="unit-title">Unit {sel.room.unit} · {fmtArea(unitRooms.reduce((s, r) => s + r.area, 0), unit)}</div>
                    {unitRooms.map((r) => (
                      <button key={r.id} className={`unit-room ${r.id === sel.room.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
                        <i style={{ background: ROOM_COLORS[r.kind] }} />{short(r)}<span>{fmtArea(r.area, unit)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <p className="fine">Procedurally generated room. Layouts are fictional and do not represent the real building.</p>
              </div>
            ) : (
              <div className="room-detail empty">
                <h3>{floor.label}</h3>
                <p>Hover or click a room to inspect it.</p>
              </div>
            )}
            <div className="room-list">
              {floor.rooms
                .filter((r) => r.kind !== 'corridor')
                .sort((x, y) => Number(!CIRCULATION_KINDS.has(x.kind)) - Number(!CIRCULATION_KINDS.has(y.kind))
                  || (x.number ?? '~').localeCompare(y.number ?? '~', undefined, { numeric: true })
                  || x.name.localeCompare(y.name, undefined, { numeric: true }))
                .map((r) => (
                  <button
                    key={r.id}
                    className={`room-row ${r.id === selected ? 'active' : ''}`}
                    onPointerEnter={() => setHover(r.id)}
                    onPointerLeave={() => setHover(null)}
                    onClick={() => setSelected(r.id)}
                  >
                    <i style={{ background: ROOM_COLORS[r.kind] }} />
                    <span className="rn">{r.name}</span>
                    <span className="ra">{fmtArea(r.area, unit)}</span>
                  </button>
                ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
