import type { Logger } from '../lib/logger.ts';

/**
 * A TanStack Query key prefix the client invalidates verbatim (contract in
 * `@rooster/core/schemas/events.ts`), e.g. `['my-list', orgId]` or `['task', taskId]`.
 */
export type QueryKey = readonly string[];

/** Who must be told about a change, and which keys they should invalidate. */
export interface Audience {
  /** The org the keys belong to; `null` for user-level keys such as `['me']`. */
  org: string | null;
  userIds: readonly string[];
  keys: readonly QueryKey[];
}

/** Domain events (04 §4.5). */
export type DomainEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.moved'
  | 'task.completed'
  | 'task.deleted'
  | 'task.restored'
  | 'task.purged'
  | 'task.expanded'
  | 'task.followed'
  | 'comment.created'
  | 'comment.updated'
  | 'comment.deleted'
  | 'comment.restored'
  | 'notification.created'
  | 'notification.read'
  | 'group.created'
  | 'group.updated'
  | 'group.moved'
  | 'group.deleted'
  | 'group.restored'
  | 'tag.created'
  | 'tag.updated'
  | 'tag.deleted'
  | 'tag.merged'
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'org.prefs'
  | 'member.joined'
  | 'member.updated'
  | 'member.removed'
  | 'invite.created'
  | 'invite.revoked'
  | 'user.updated'
  /** `subjects` holds the user ID; every stream of that user is closed. */
  | 'user.disabled'
  /** `subjects` holds the session ID (sign-out, revoke, expiry); its streams are closed. */
  | 'session.ended';

export interface DomainEvent {
  type: DomainEventType;
  /** The org the change happened in; `null` for user-level changes. */
  orgId: string | null;
  /** The user who caused it; `null` for system work (sign-out hooks, jobs). */
  actorId: string | null;
  /** `X-Rooster-Client-Id` of the request that caused it, so that tab can skip a refetch. */
  origin: string | null;
  /** The primary entity IDs (tasks, group, tag, user or session). */
  subjects: readonly string[];
  /** Resolved inside the emitting transaction, so membership is exactly as committed. */
  audiences: readonly Audience[];
  /**
   * Messages for one user's streams other than invalidations, such as `notification`
   * (the unread count plus a preview). Sent as they are, never coalesced.
   */
  direct?: readonly DirectMessage[];
  /**
   * For changes that can move tasks out of a grant's read groups (P8): each affected task's
   * grant group per user before the change (task → user → group; a user not listed had none).
   * Grant streams use it to tell "was readable, now gone" from "never readable".
   */
  priorGroups?: PriorGroups;
}

export type PriorGroups = ReadonlyMap<string, ReadonlyMap<string, string | null>>;

export interface DirectMessage {
  userId: string;
  event: 'notification';
  data: unknown;
}

export type DomainEventListener = (event: DomainEvent) => void;

/**
 * The in-process, typed event bus (04 §4.5). Services publish only after their transaction
 * committed (`emitAfterCommit` in services/context.ts); listeners run synchronously and a
 * failing listener never affects the request or the other listeners.
 */
export class EventBus {
  private readonly listeners = new Set<DomainEventListener>();
  private grantStreamProbe: ((org: string) => boolean) | null = null;

  constructor(private readonly logger?: Logger) {}

  /** Set by the SSE hub: whether a grant's stream reaching `org` is open (P8). */
  setGrantStreamProbe(probe: ((org: string) => boolean) | null): void {
    this.grantStreamProbe = probe;
  }

  /**
   * Whether an open grant stream reaches `org`. Services capture `priorGroups` only then:
   * nobody else reads them.
   */
  hasGrantStream(org: string): boolean {
    return this.grantStreamProbe?.(org) ?? false;
  }

  /** Subscribes; returns the unsubscribe function. */
  on(listener: DomainEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger?.error({ err, type: event.type }, 'event listener failed');
      }
    }
  }
}
