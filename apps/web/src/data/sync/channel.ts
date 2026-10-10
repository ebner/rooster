import type { SyncState } from '../../state/sync-store';
import type { OutboxRecord } from './outbox';

/** A problem+json failure as it crosses tabs (an `ApiError` is not structured-cloneable). */
export interface WireError {
  code: string;
  status: number;
  message: string;
}

/** What tabs tell each other on `BroadcastChannel('rooster')` (04 §6.2). */
export type SyncMessage =
  /**
   * A tab queued ops: every tab replays them optimistically. `stored: false` when the outbox
   * write failed (the ops then live only in the tabs' memory).
   */
  | { type: 'enqueued'; records: OutboxRecord[]; stored?: boolean }
  /** The leader got a 2xx: every tab folds the op into its confirmed state. */
  | { type: 'applied'; opId: string; response: unknown }
  /** The leader dropped an op (403/404/409/410/422): every tab reverts it. */
  | { type: 'dropped'; opId: string; error: WireError }
  /** A pending client tag id turned out to exist already (`409 tag_name_taken`). */
  | { type: 'remap'; opId: string; from: string; to: string }
  /** A follower asks the leader to try the outbox now (retry, reconnect, foreground). */
  | { type: 'flush' }
  /**
   * A follower whose queue made no progress asks whether the leader is alive. The leader answers
   * with `status` and re-reads the outbox; without an answer the follower takes the lock.
   */
  | { type: 'ping' }
  /** The leader's sender state, so every tab shows the same pill. */
  | {
      type: 'status';
      status: Pick<SyncState, 'syncing' | 'failures' | 'lastError' | 'sessionExpired'>;
    }
  /**
   * Signed out, or another user signed in: drop every local copy. `userId`: the account whose
   * session ended; every tab deletes that account's outbox records it may still have written.
   */
  | { type: 'cleared'; userId?: string }
  /**
   * That account's session ended (an online 401 on `/me`): its tabs stop saving and drop their
   * cache like the tab that saw it. Its outbox records stay, for when it signs in again.
   */
  | { type: 'expired'; userId: string };

export interface SyncChannel {
  post(message: SyncMessage): void;
  /** Messages from other tabs (never this tab's own). */
  listen(handler: (message: SyncMessage) => void): () => void;
  close(): void;
}

export const syncChannelName = 'rooster';

export function createSyncChannel(name: string = syncChannelName): SyncChannel {
  if (typeof BroadcastChannel === 'undefined') return nullChannel();
  const channel = new BroadcastChannel(name);
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // An uncloneable response body: the other tabs refetch on their next trigger.
      }
    },
    listen: (handler) => {
      const listener = (event: MessageEvent<SyncMessage>) => handler(event.data);
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close: () => channel.close(),
  };
}

/** A channel that talks to nobody (one tab, tests). */
export function nullChannel(): SyncChannel {
  return { post: () => {}, listen: () => () => {}, close: () => {} };
}
