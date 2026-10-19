// Small worker pool for tile geometry generation. A worker that errors or
// stalls is replaced and its job retried, so one bad tile can't wedge loading.
import type { TileData } from '@indy/shared';
import type { BuildingMeshData, GroundMeshData } from './geometryBuilder.ts';
import TileWorker from './tileWorker.ts?worker';

export interface TileMeshResult {
  key: string;
  buildings: BuildingMeshData;
  ground: GroundMeshData;
}

interface Job {
  id: number;
  tile: TileData;
  opts: { lite?: boolean; origin?: [number, number] };
  attempts: number;
  resolve: (r: TileMeshResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  timer: number;
}

const SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
const JOB_TIMEOUT = 15_000;
const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1;
let loadFailures = 0;
let broken = false;

function spawn(): Slot {
  const slot: Slot = { worker: new TileWorker(), job: null, timer: 0 };
  slot.worker.onmessage = (e) => {
    const job = slot.job;
    if (!job || e.data.job !== job.id) return;
    clearTimeout(slot.timer);
    slot.job = null;
    loadFailures = 0;
    if (e.data.error) job.reject(new Error(e.data.error));
    else job.resolve(e.data as TileMeshResult);
    pump();
  };
  slot.worker.onerror = (e) => {
    console.warn('tile worker error', e.message ?? '(worker script failed to load)');
    e.preventDefault();
    if (++loadFailures > 6) {
      // Workers can't start at all: stop retrying and fail queued jobs.
      broken = true;
      for (const job of queue.splice(0)) job.reject(new Error('tile workers unavailable'));
    }
    restart(slot);
  };
  return slot;
}

/** Replace a broken or stalled worker and retry its job. */
function restart(slot: Slot) {
  clearTimeout(slot.timer);
  slot.worker.terminate();
  const job = slot.job;
  const i = slots.indexOf(slot);
  if (i >= 0) {
    if (broken) slots.splice(i, 1);
    else slots[i] = spawn();
  }
  if (job) {
    if (++job.attempts < 3) queue.unshift(job);
    else job.reject(new Error(`tile ${job.tile.key} failed after retries`));
  }
  pump();
}

function pump() {
  if (broken) return;
  while (slots.length < SIZE) slots.push(spawn());
  for (const slot of slots) {
    if (slot.job || !queue.length) continue;
    const job = queue.shift()!;
    slot.job = job;
    slot.timer = window.setTimeout(() => {
      console.warn(`tile ${job.tile.key} timed out; restarting worker`);
      restart(slot);
    }, JOB_TIMEOUT);
    slot.worker.postMessage({ job: job.id, tile: job.tile, ...job.opts });
  }
}

export function buildTileMesh(tile: TileData, opts: { lite?: boolean; origin?: [number, number] } = {}): Promise<TileMeshResult> {
  return new Promise((resolve, reject) => {
    if (broken) return reject(new Error('tile workers unavailable'));
    queue.push({ id: nextId++, tile, opts, attempts: 0, resolve, reject });
    pump();
  });
}

export const jobStats = () => ({ workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length });
