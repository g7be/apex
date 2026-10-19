import { useEffect, useState } from 'react';
import { game, useGame } from '../state/store.ts';
import { getBuilding } from '../world/worldData.ts';
import { net } from '../net/connection.ts';
import { dateTime, duration, money } from './format.ts';
import { FootprintSvg } from './PropertyPanel.tsx';
import { focusBuilding } from '../game/actions.ts';
import { flyTo } from '../game/MapCamera.tsx';

export function LeaseDialog() {
  const dialog = useGame((s) => s.dialog);
  const me = useGame((s) => s.me);
  const config = useGame((s) => s.config);
  const lease = useGame((s) => (s.dialog ? s.leases[s.dialog.buildingId] : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    setError(null);
    setBusy(false);
    if (dialog?.kind === 'rename') setName(lease?.customName ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dialog) game.set({ dialog: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  if (!dialog || !me || !config) return null;
  const b = getBuilding(dialog.buildingId);
  if (!b) return null;
  const price = b.profile.monthlyRent;
  const close = () => game.set({ dialog: null });
  const hours = Math.round(config.leaseDurationMs / 3_600_000);
  const after = me.balance - price;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = dialog.kind === 'rename'
      ? await net.request({ t: 'rename', buildingId: dialog.buildingId, name })
      : await net.request({ t: dialog.kind, buildingId: dialog.buildingId });
    setBusy(false);
    if (!res.ok) return setError(res.error ?? 'Something went wrong.');
    close();
    const label = b.profile.displayName;
    if (dialog.kind === 'rent') game.toast(`You leased ${label}! It is now yours for ${hours}h.`, 'success');
    if (dialog.kind === 'renew') game.toast(`Lease renewed until ${dateTime(res.lease!.expiresAt)}.`, 'success');
    if (dialog.kind === 'release') game.toast(`You ended your lease on ${label}.`);
    if (dialog.kind === 'rename') game.toast('Building renamed.', 'success');
  };

  const titles = { rent: 'Rent this building?', renew: 'Renew your lease?', release: 'End your lease?', rename: 'Name your building' };
  const confirm = { rent: `Rent for ${money(price)}`, renew: `Pay ${money(price)} & renew`, release: 'End lease now', rename: 'Save name' };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog" role="dialog" aria-label={titles[dialog.kind]}>
        <h3>{titles[dialog.kind]}</h3>
        <div className="dialog-building">
          <FootprintSvg fp={b.record.fp} holes={b.record.holes} size={64} />
          <div>
            <b>{lease?.customName ?? b.profile.displayName}</b>
            <span>{b.profile.clsLabel} · {b.profile.floors} floors</span>
          </div>
        </div>
        {(dialog.kind === 'rent' || dialog.kind === 'renew') && (
          <div className="ledger">
            <div><span>Your balance</span><b>{money(me.balance)}</b></div>
            <div><span>First month{dialog.kind === 'renew' ? ' (extension)' : ''}</span><b className="neg">− {money(price).slice(1)}</b></div>
            <div className="total"><span>Balance after</span><b className={after < 0 ? 'neg' : ''}>{money(after)}</b></div>
            <p className="fine">
              {dialog.kind === 'rent'
                ? `Lease term: one in-game month (${hours}h real time). Renew any time to extend; expired leases return the building to the market.`
                : `Extends the lease by ${hours}h from ${lease ? dateTime(Math.max(Date.now(), lease.expiresAt)) : 'now'}. Up to 3 terms can be prepaid.`}
              {' '}All amounts are fictional in-game currency.
            </p>
          </div>
        )}
        {dialog.kind === 'release' && lease && (
          <p className="dialog-text">Your lease has {duration(lease.expiresAt - Date.now())} left. Ending it now returns the building to the market immediately, with no refund.</p>
        )}
        {dialog.kind === 'rename' && (
          <input className="text-input" autoFocus maxLength={40} placeholder={b.profile.displayName} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        )}
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button
            className={`btn ${dialog.kind === 'release' ? 'danger' : 'primary'}`}
            disabled={busy || ((dialog.kind === 'rent' || dialog.kind === 'renew') && after < 0)}
            onClick={submit}
          >
            {busy ? 'Processing…' : (dialog.kind === 'rent' || dialog.kind === 'renew') && after < 0 ? 'Insufficient funds' : confirm[dialog.kind]}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MyProperties() {
  const open = useGame((s) => s.myPropertiesOpen);
  const me = useGame((s) => s.me);
  const allLeases = useGame((s) => s.leases);
  const leases = Object.values(allLeases).filter((l) => l.playerId === me?.id);
  useGame((s) => s.dataVersion);
  if (!open || !me) return null;
  const close = () => game.set({ myPropertiesOpen: false });
  const total = leases.reduce((s, l) => s + l.monthlyRent, 0);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog wide">
        <div className="dialog-head">
          <h3>Your properties</h3>
          <button className="icon-btn" onClick={close}>✕</button>
        </div>
        {leases.length === 0 && <p className="dialog-text">You don't lease any buildings yet. Click a building in the city and choose <b>Rent building</b>.</p>}
        <div className="prop-list">
          {leases.map((l) => {
            const b = getBuilding(l.buildingId);
            return (
              <button key={l.buildingId} className="prop-row" onClick={() => {
                game.set({ myPropertiesOpen: false });
                if (b) focusBuilding(l.buildingId);
                else if (l.center) { flyTo(l.center[0], -l.center[1], 260); game.set({ selectedId: l.buildingId }); }
              }}>
                {b && <FootprintSvg fp={b.record.fp} size={44} color="#3ddc84" />}
                <div className="prop-main">
                  <b>{l.customName ?? b?.profile.displayName ?? l.buildingName ?? l.buildingId}</b>
                  <span>{b?.profile.clsLabel ?? ''} · expires in {duration(l.expiresAt - Date.now())}</span>
                </div>
                <span className="prop-price">{money(l.monthlyRent)}/mo</span>
              </button>
            );
          })}
        </div>
        {leases.length > 0 && <div className="prop-total">{leases.length} leases · {money(total)} per month · balance {money(me.balance)}</div>}
      </div>
    </div>
  );
}
