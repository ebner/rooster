import type { ListOp } from '@rooster/core/reducers';
import type { MyList, Tag, TaskDetail } from '@rooster/core/schemas';
import { ApiError } from '../errors';

/**
 * How the mutation pipeline talks to the server. Production uses the HTTP transport over
 * `@rooster/api-client`; the dev fixture and tests use an in-memory server behind the same
 * interface, so the pipeline itself is identical everywhere.
 */
export interface ListTransport {
  fetchMyList: (orgId: string) => Promise<MyList>;
  /** GET /tasks/:id (P3): the task with its description, direct subtasks and parent chain. */
  fetchTask: (taskId: string) => Promise<TaskDetail>;
  /** GET /orgs/:orgId/tags (P3). */
  fetchTags: (orgId: string) => Promise<Tag[]>;
  /**
   * Sends one op; resolves with the response body (undefined for 204), throws `ApiError`.
   * The pipeline aborts `signal` when the request takes too long.
   */
  send: (op: ListOp, orgId: string, signal?: AbortSignal) => Promise<unknown>;
}

/** An `ApiError` for 429, carrying `Retry-After`. */
export class RateLimitedError extends ApiError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('rate_limited', 429);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The headers every list mutation carries (04 §6.2, 06 §1). */
export function opHeaders(op: ListOp): Record<string, string> {
  return {
    'Idempotency-Key': op.opId,
    'X-Rooster-Edit-Time': String(op.editTime),
    'X-Rooster-Client-Id': op.clientId,
  };
}

/** Seconds or an HTTP date (RFC 9110 §10.2.3); defaults to 5 s. */
export function parseRetryAfter(value: string | null, now: number): number {
  if (!value) return 5_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 5_000 : Math.max(0, date - now);
}

export type FailureClass = 'drop' | 'auth' | 'rate' | 'transient';

/**
 * 04 §6.2: client errors that will never succeed are dropped (and reverted); 401 pauses;
 * 429 waits for Retry-After; 5xx and network errors retry with backoff.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (!(error instanceof ApiError)) return 'transient';
  if (error.status === 401) return 'auth';
  if (error.status === 429) return 'rate';
  if (error.status >= 500 || error.status === 408) return 'transient';
  return 'drop';
}
