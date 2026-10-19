// Gameplay actions shared by keyboard shortcuts and UI buttons.
import { generateInterior, type BuildingInterior } from '@indy/shared';
import { game } from '../state/store.ts';
import { getBuilding } from '../world/worldData.ts';
import { flyTo } from './MapCamera.tsx';

export function interiorFor(id: string): BuildingInterior | null {
  const b = getBuilding(id);
  return b ? generateInterior(b.record, b.profile) : null;
}

export function openFloorPlan(id: string) {
  game.set({ floorPlanFor: id });
}

/** Select a building and center the map on it. */
export function focusBuilding(id: string) {
  const b = getBuilding(id);
  game.set({ selectedId: id });
  if (b) flyTo(b.record.centroid[0], -b.record.centroid[1], Math.max(180, Math.min(600, b.profile.height * 4 + Math.sqrt(b.profile.footprintArea) * 3)));
}
