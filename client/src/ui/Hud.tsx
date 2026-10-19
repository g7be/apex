import { useEffect, useRef, useState } from 'react';
import { game, useGame } from '../state/store.ts';
import { cameraState } from '../state/live.ts';
import { cameraTarget, flyTo, setTargetDistance } from '../game/MapCamera.tsx';
import { money } from './format.ts';
import { net } from '../net/connection.ts';

function Balance({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const [delta, setDelta] = useState<number | null>(null);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value) return;
    setDelta(value - from);
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 700);
      setShown(Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const clear = setTimeout(() => setDelta(null), 2200);
    return () => { cancelAnimationFrame(raf); clearTimeout(clear); };
  }, [value]);
  return (
    <div className="balance">
      <span className="balance-value">{money(shown)}</span>
      {delta != null && <span className={`balance-delta ${delta < 0 ? 'neg' : 'pos'}`}>{delta < 0 ? '−' : '+'}{money(Math.abs(delta)).slice(1)}</span>}
    </div>
  );
}

function PlayerCard() {
  const me = useGame((s) => s.me);
  const connection = useGame((s) => s.connection);
  const online = useGame((s) => Object.keys(s.players).length + (s.me ? 1 : 0));
  const leases = useGame((s) => Object.values(s.leases).filter((l) => l.playerId === s.me?.id).length);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  if (!me) return null;
  return (
    <div className="hud-card player-card">
      <div className="avatar-dot" style={{ background: me.color }} />
      <div className="player-meta">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); net.setName(name); setEditing(false); }}>
            <input autoFocus className="name-input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} onBlur={() => setEditing(false)} />
          </form>
        ) : (
          <button className="player-name" title="Rename" onClick={() => { setName(me.name); setEditing(true); }}>{me.name}</button>
        )}
        <Balance value={me.balance} />
      </div>
      <div className="player-stats">
        <button className="chip" onClick={() => game.set({ myPropertiesOpen: true })} title="Your leased buildings">🏢 {leases}</button>
        {connection === 'solo' ? <span className="chip conn solo" title="No game server connected: progress is saved in this browser only">● Solo</span> : <span className={`chip conn ${connection}`} title={`Server: ${connection}`}>● {online} online</span>}
      </div>
    </div>
  );
}

function LocationBar() {
  const loc = useGame((s) => s.location);
  return (
    <div className="location-bar">
      <div className="loc-main">{loc.neighborhood || 'Downtown Indianapolis'}</div>
      <div className="loc-sub">{loc.street || 'Indiana'}</div>
    </div>
  );
}

/** Zoom buttons, compass (click to face north) and a button back to Monument Circle. */
function MapControls() {
  const compass = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (compass.current) compass.current.style.setProperty('--yaw', `${(cameraState.yaw * 180) / Math.PI}deg`);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  const zoom = (k: number) => {
    setTargetDistance(cameraTarget.distance * k);
  };
  return (
    <div className="map-controls">
      <button onClick={() => zoom(1 / 1.6)} title="Zoom in (+ or scroll)">＋</button>
      <button onClick={() => zoom(1.6)} title="Zoom out (− or scroll)">－</button>
      <button ref={compass} className="compass" onClick={() => { cameraTarget.yaw = 0; cameraTarget.pitch = Math.max(cameraTarget.pitch, 0.95); }} title="Face north">
        <span>N</span>
      </button>
      <button onClick={() => flyTo(0, 0, 420)} title="Back to Monument Circle (Home)">⌂</button>
    </div>
  );
}

function HintBar() {
  return (
    <div className="hint-bar">
      <span><kbd>Drag</kbd> pan</span>
      <span><kbd>Scroll</kbd> zoom</span>
      <span><kbd>Right-drag</kbd> rotate / tilt</span>
      <span><kbd>W A S D</kbd> pan</span>
      <span><kbd>Q E</kbd> rotate</span>
      <span><kbd>Click</kbd> select</span>
      <span><kbd>R</kbd> rooms</span>
      <span><kbd>H</kbd> help</span>
    </div>
  );
}

export function Hud() {
  return (
    <>
      <PlayerCard />
      <LocationBar />
      <MapControls />
      <HintBar />
    </>
  );
}
