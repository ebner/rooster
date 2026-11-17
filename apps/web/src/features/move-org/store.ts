import { ancestorsOf, type ListState } from '@rooster/core/reducers';
import { create } from 'zustand';
import { useMe } from '../../data/me';

/**
 * ADR 0072 §22: "Move to organisation…" asked for in a list (the bulk bar, phone selection
 * mode, the palette). The list showing `orgId` renders the picker: a popover anchored to the
 * bulk bar or the cursor row on desktop, a sheet on phones. The pane keeps its own state.
 */
export interface MoveOrgRequest {
  /** The source org (the list that asked). */
  orgId: string;
  ids: readonly string[];
  anchor: 'bulk' | 'cursor';
}

export const useMoveOrgRequest = create<{ request: MoveOrgRequest | null }>(() => ({
  request: null,
}));

export function openMoveOrg(request: MoveOrgRequest): void {
  useMoveOrgRequest.setState({ request });
}

export function closeMoveOrg(): void {
  useMoveOrgRequest.setState({ request: null });
}

/** How long a followed pane trusts the move over a detail that still names the source org. */
export const followTrustMs = 60_000;

const followed = new Map<string, { orgId: string; at: number }>();

/**
 * The pane followed a moved task to `orgId` (ADR 0072 §22). Until the server's detail names
 * the new org, the pane's URL check (§23) must not send it back to the source org.
 */
export function noteFollowed(taskId: string, orgId: string, now = Date.now()): void {
  followed.set(taskId, { orgId, at: now });
}

/** The org a pane recently followed `taskId` to, or null. */
export function followedTo(taskId: string, now = Date.now()): string | null {
  const entry = followed.get(taskId);
  if (!entry) return null;
  if (now - entry.at > followTrustMs) {
    followed.delete(taskId);
    return null;
  }
  return entry.orgId;
}

export function forgetFollowed(taskId: string): void {
  followed.delete(taskId);
}

/**
 * ADR 0072 §23: the org slug a pane at `urlOrgId` must move to, or null when it stays. A task
 * whose org (from the server) differs from the URL's is shown under its own org, unless the
 * pane just followed a move there and the detail hasn't caught up yet.
 */
export function paneOrgRedirect(input: {
  taskId: string;
  urlOrgId: string;
  taskOrgId: string | undefined;
  orgs: readonly { id: string; slug: string; isPersonal: boolean }[];
  now?: number;
}): string | null {
  const { taskId, urlOrgId, taskOrgId, orgs } = input;
  if (!taskOrgId || taskOrgId === urlOrgId) return null;
  if (followedTo(taskId, input.now) === urlOrgId) return null;
  const org = orgs.find((o) => o.id === taskOrgId);
  if (!org) return null;
  return org.isPersonal ? 'personal' : org.slug;
}

/** Whether moving `ids` takes `taskId` along: it is one of them or one of their descendants. */
export function movesWith(
  state: ListState | undefined,
  taskId: string | null,
  ids: readonly string[],
): boolean {
  if (!taskId) return false;
  if (ids.includes(taskId)) return true;
  if (!state?.tasks[taskId]) return false;
  const moving = new Set(ids);
  return ancestorsOf(state, taskId).some((a) => moving.has(a.id));
}

/** Whether to offer the move at all: it needs a second org (ADR 0072 §22). */
export function useCanMoveToOrg(): boolean {
  return (useMe().data?.orgs.length ?? 0) > 1;
}
