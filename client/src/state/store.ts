// UI-facing game state. High-frequency data (positions) lives in plain mutable
// objects in ./live.ts instead, so React only re-renders on meaningful changes.
import { create } from 'zustand';
import type { ChatChannel, Lease, PlayerPublic, PlayerSelf, ServerConfigPublic, WorldManifest } from '@indy/shared';

export interface ChatEntry {
  id: number;
  from: PlayerPublic | null;
  text: string;
  channel: ChatChannel | 'system';
  ts: number;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export type DialogState =
  | { kind: 'rent'; buildingId: string }
  | { kind: 'renew'; buildingId: string }
  | { kind: 'release'; buildingId: string }
  | { kind: 'rename'; buildingId: string }
  | null;

export interface GameState {
  connection: 'idle' | 'connecting' | 'online' | 'offline';
  me: PlayerSelf | null;
  config: ServerConfigPublic | null;
  serverTimeOffset: number;
  players: Record<string, PlayerPublic>;
  leases: Record<string, Lease>;

  manifest: WorldManifest | null;
  loading: { tilesLoaded: number; tilesTotal: number; ready: boolean; error?: string };
  /** Bumped when building data for more tiles arrives. */
  dataVersion: number;

  selectedId: string | null;
  floorPlanFor: string | null;
  dialog: DialogState;
  myPropertiesOpen: boolean;
  helpOpen: boolean;
  location: { neighborhood: string; street: string };
  chat: ChatEntry[];
  chatFocused: boolean;
  toasts: Toast[];
  pending: boolean;
}

let nextId = 1;

export const useGame = create<GameState>(() => ({
  connection: 'idle',
  me: null,
  config: null,
  serverTimeOffset: 0,
  players: {},
  leases: {},
  manifest: null,
  loading: { tilesLoaded: 0, tilesTotal: 0, ready: false },
  dataVersion: 0,
  selectedId: null,
  floorPlanFor: null,
  dialog: null,
  myPropertiesOpen: false,
  helpOpen: false,
  location: { neighborhood: '', street: '' },
  chat: [],
  chatFocused: false,
  toasts: [],
  pending: false,
}));

export const game = {
  get: useGame.getState,
  set: useGame.setState,
  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = nextId++;
    useGame.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => useGame.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 3500);
  },
  addChat(entry: Omit<ChatEntry, 'id'>) {
    useGame.setState((s) => ({ chat: [...s.chat.slice(-80), { ...entry, id: nextId++ }] }));
  },
  select(id: string | null) {
    useGame.setState({ selectedId: id });
  },
  serverNow() {
    return Date.now() + useGame.getState().serverTimeOffset;
  },
};
