import { create } from 'zustand';

/** 04 §5.2 `syncStore` (P2: in-memory queue; SSE and persistence arrive in P4). */
export interface SyncState {
  online: boolean;
  /** Ops waiting to be sent or in flight. */
  pending: number;
  /** Consecutive transient failures of the head op. */
  failures: number;
  /** 401: the queue is paused until the user signs in again. */
  sessionExpired: boolean;
}

export const useSyncStore = create<SyncState>()(() => ({
  online: globalThis.navigator?.onLine ?? true,
  pending: 0,
  failures: 0,
  sessionExpired: false,
}));

/** 02 §14: after 3 failed retries the pill shows "Sync problem · Retry". */
export const syncProblemAfter = 3;
