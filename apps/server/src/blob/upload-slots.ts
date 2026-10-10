import { AppError } from '../lib/errors.ts';

/**
 * Uploads one user may stream at once. Each holds a temp file under `<dataDir>/tmp` (on the
 * database's volume) until it is stored, so the count bounds a user's share of that space.
 */
export const UPLOADS_IN_FLIGHT_PER_USER = 3;
/** `Retry-After` of the `429` past that: an upload of the default 25 MB takes seconds. */
const UPLOAD_RETRY_AFTER_S = 5;

export interface UploadSlot {
  /** Counts `n` more bytes of this upload's file; throws the budget's error once it is spent. */
  take(n: number): void;
  /** Gives the slot and its bytes back; idempotent. */
  release(): void;
}

export interface UploadBudget {
  /** Bytes the user's uploads in flight may hold together. */
  bytes: number;
  error: () => AppError;
}

/**
 * Per-user accounting of uploads in flight. A quota checked only once an upload has finished
 * leaves the temp files of unfinished ones uncounted: a client that never sends the closing
 * boundary could hold any number of partial files. Here a user streams at most `perUser`
 * uploads at once (`429 rate_limited` past that), and their bytes together stay within the
 * budget given (the rest of the storage quota), checked as every chunk arrives.
 */
export class UploadSlots {
  private readonly users = new Map<string, { uploads: number; bytes: number }>();

  constructor(private readonly perUser = UPLOADS_IN_FLIGHT_PER_USER) {}

  acquire(userId: string, budget?: UploadBudget): UploadSlot {
    let entry = this.users.get(userId);
    if (entry !== undefined && entry.uploads >= this.perUser) {
      const busy = new AppError(
        'rate_limited',
        429,
        'Too many uploads at once; wait for one to finish.',
      );
      busy.headers = { 'Retry-After': String(UPLOAD_RETRY_AFTER_S) };
      throw busy;
    }
    if (budget !== undefined && (entry?.bytes ?? 0) > budget.bytes) throw budget.error();
    if (entry === undefined) {
      entry = { uploads: 0, bytes: 0 };
      this.users.set(userId, entry);
    }
    const held = entry;
    held.uploads += 1;
    let mine = 0;
    let released = false;
    return {
      take: (n) => {
        if (released) return;
        mine += n;
        held.bytes += n;
        if (budget !== undefined && held.bytes > budget.bytes) throw budget.error();
      },
      release: () => {
        if (released) return;
        released = true;
        held.uploads -= 1;
        held.bytes -= mine;
        if (held.uploads === 0) this.users.delete(userId);
      },
    };
  }

  /** A user's uploads and bytes in flight, for tests. */
  inFlight(userId: string): { uploads: number; bytes: number } {
    const entry = this.users.get(userId);
    return { uploads: entry?.uploads ?? 0, bytes: entry?.bytes ?? 0 };
  }
}
