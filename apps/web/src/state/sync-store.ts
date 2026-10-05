import { create } from 'zustand';

/** The SSE stream (04 §4.5): `paused` while the page is hidden for a while. */
export type SseState = 'idle' | 'connecting' | 'open' | 'closed' | 'paused';

/** 04 §5.2 `syncStore`: what the sync pill, banners and tests read. */
export interface SyncState {
  online: boolean;
  /** Ops waiting to be sent or in flight (every tab mirrors the shared outbox). */
  pending: number;
  /** The leader tab is sending ops right now. */
  syncing: boolean;
  /** Consecutive transient failures of the head op. */
  failures: number;
  /** The last failure's code (`network`, `http_503`, …), cleared by a success. */
  lastError: string | null;
  /** 401: the queue is paused until the user signs in again. */
  sessionExpired: boolean;
  sseState: SseState;
  /** This tab holds the `rooster-outbox` lock and flushes the outbox. */
  leader: boolean;
}

export const useSyncStore = create<SyncState>()(() => ({
  online: globalThis.navigator?.onLine ?? true,
  pending: 0,
  syncing: false,
  failures: 0,
  lastError: null,
  sessionExpired: false,
  sseState: 'idle',
  leader: false,
}));

/** 02 §14: after 3 failed retries the pill shows "Sync problem · Retry". */
export const syncProblemAfter = 3;

export type SyncPillState = 'offline' | 'pending' | 'syncing' | 'error';

/**
 * The header pill (03 §3.15, 02 §14), or null when everything is saved. Offline wins over a
 * sync problem: retries are paused until the network is back.
 */
export function syncPillState(
  s: Pick<SyncState, 'online' | 'pending' | 'failures' | 'syncing'>,
): SyncPillState | null {
  if (!s.online) return s.pending > 0 ? 'pending' : 'offline';
  if (s.failures >= syncProblemAfter) return 'error';
  if (s.pending > 0) return 'syncing';
  return null;
}
