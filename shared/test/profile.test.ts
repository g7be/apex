import { describe, expect, it } from 'vitest';
import { computeMonthlyRent, deriveProfile, parseLength, parseColour } from '../src/index.ts';
import { building, rect } from './fixtures.ts';

describe('OSM tag parsing', () => {
  it('parses heights in meters and feet', () => {
    expect(parseLength('45')).toBe(45);
    expect(parseLength('45 m')).toBe(45);
    expect(parseLength('12.5m')).toBe(12.5);
    expect(parseLength("100'")).toBeCloseTo(30.48, 2);
    expect(parseLength('bogus')).toBeUndefined();
  });
  it('parses colours', () => {
    expect(parseColour('#ABC')).toBe('#aabbcc');
    expect(parseColour('dark grey')).toBe('#5b5b5b');
    expect(parseColour('puce-ish')).toBeUndefined();
  });
});

describe('building profiles', () => {
  it('prefers real OSM levels and heights', () => {
    const p = deriveProfile(building('t-levels', rect(0, 0, 30, 20), { building: 'office', 'building:levels': '12', height: '50' }));
    expect(p.floors).toBe(12);
    expect(p.height).toBe(50);
    expect(p.cls).toBe('office');
    expect(p.heightSource).toBe('osm:height');
  });

  it('derives floors from height alone', () => {
    const p = deriveProfile(building('t-height', rect(0, 0, 30, 20), { building: 'office', height: '39' }));
    expect(p.floors).toBe(10);
  });

  it('is deterministic for the same id and differs between ids', () => {
    const a1 = deriveProfile(building('osm:w1', rect(0, 0, 25, 18)));
    const a2 = deriveProfile({ ...building('osm:w1', rect(0, 0, 25, 18)) });
    expect(a2).toEqual(a1);
    const styles = new Set(Array.from({ length: 30 }, (_, i) => deriveProfile(building(`osm:w${100 + i}`, rect(0, 0, 25, 18))).wallColor));
    expect(styles.size).toBeGreaterThan(3);
  });

  it('classifies from tags', () => {
    expect(deriveProfile(building('c1', rect(0, 0, 20, 20), { building: 'apartments' })).cls).toBe('residential');
    expect(deriveProfile(building('c2', rect(0, 0, 20, 20), { building: 'yes', shop: 'clothes' })).cls).toBe('retail');
    expect(deriveProfile(building('c3', rect(0, 0, 20, 20), { building: 'parking' })).cls).toBe('parking');
    expect(deriveProfile(building('c4', rect(0, 0, 20, 20), { building: 'roof' })).rentable).toBe(false);
  });
});

describe('virtual rent', () => {
  it('scales with size, class and location like the design examples', () => {
    const small = computeMonthlyRent('retail', 180, [0, 0], false);
    const medium = computeMonthlyRent('office', 1500, [300, 0], false);
    const large = computeMonthlyRent('retail', 9000, [200, 200], false);
    expect(small).toBeGreaterThanOrEqual(250);
    expect(small).toBeLessThan(1000);
    expect(medium).toBeGreaterThan(1500);
    expect(medium).toBeLessThan(4000);
    expect(large).toBeGreaterThan(7000);
    expect(computeMonthlyRent('office', 1500, [2000, 0], false)).toBeLessThan(medium);
    expect(small % 50).toBe(0);
  });
});
