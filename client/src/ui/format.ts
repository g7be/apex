export const SQFT_PER_M2 = 10.7639;

/** In-game currency ("Indy Dollars"), shown with a ₵ sign to keep it clearly fictional. */
export const money = (v: number) => `₵${Math.round(v).toLocaleString('en-US')}`;

export function area(m2: number, unit: 'm2' | 'ft2' = 'ft2') {
  return unit === 'ft2' ? `${Math.round(m2 * SQFT_PER_M2).toLocaleString('en-US')} sq ft` : `${Math.round(m2).toLocaleString('en-US')} m²`;
}

export function duration(ms: number) {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${Math.max(1, mm)}m`;
}

export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
