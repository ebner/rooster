import { useCallback } from 'react';
import { create } from 'zustand';
import { onSessionDataCleared } from '../../data/session-events';
import { userStorageKey } from '../../lib/user-storage';

/**
 * Which sidebar sections are open (ADR 0076). The server's `collapsed` org pref is a plain
 * boolean, so it can't tell "never touched" from "expanded"; this browser keeps a tri-state per
 * section instead (open, closed, or unset), per user (`userStorageKey`, swept on sign-out). An
 * unset section follows `sectionCollapsed`'s default.
 */

export type SectionState = 'open' | 'closed';

/** The All organisations section's ID in the store (no org has it: org IDs are UUIDs). */
export const allOrgsSectionId = 'all';

/** From this many orgs on, the orgs other than the one shown start collapsed. */
export const collapseOrgsFrom = 3;

const storageName = (sectionId: string) => `sidebar.section.${sectionId}`;
const cacheKey = (userId: string, sectionId: string) => `${userId}|${sectionId}`;

/** Toggles made in this page, over what storage held when the sidebar first read it. */
const useSectionStore = create<{ states: Readonly<Record<string, SectionState>> }>()(() => ({
  states: {},
}));

onSessionDataCleared(() => useSectionStore.setState({ states: {} }));

function readStored(userId: string, sectionId: string): SectionState | null {
  try {
    const value = globalThis.localStorage?.getItem(userStorageKey(userId, storageName(sectionId)));
    return value === 'open' || value === 'closed' ? value : null;
  } catch {
    return null;
  }
}

/** The user's explicit choice for a section on this browser, or null when they made none. */
export function sectionState(userId: string, sectionId: string): SectionState | null {
  return (
    useSectionStore.getState().states[cacheKey(userId, sectionId)] ?? readStored(userId, sectionId)
  );
}

/** Records an explicit open or close; it wins over every default from now on. */
export function setSectionState(userId: string, sectionId: string, state: SectionState): void {
  useSectionStore.setState((s) => ({
    states: { ...s.states, [cacheKey(userId, sectionId)]: state },
  }));
  try {
    globalThis.localStorage?.setItem(userStorageKey(userId, storageName(sectionId)), state);
  } catch {
    // Blocked storage: the choice holds for this page only.
  }
}

/** A reader of the explicit states that re-renders the caller when one changes. */
export function useSectionStates(userId: string): (sectionId: string) => SectionState | null {
  const changed = useSectionStore((s) => s.states);
  return useCallback(
    (sectionId: string) => changed[cacheKey(userId, sectionId)] ?? readStored(userId, sectionId),
    [changed, userId],
  );
}

export interface OrgSectionInput {
  /** The explicit state on this browser (`sectionState`). */
  stored: SectionState | null;
  /** The server's `org_member_pref.collapsed`: true only after an explicit collapse. */
  serverCollapsed: boolean;
  /** The org in the URL. */
  active: boolean;
  /** How many orgs the user has. */
  orgCount: number;
}

/**
 * Whether an org's section is collapsed (ADR 0076). An explicit choice wins: this browser's,
 * else a collapse stored on the server. Unset, the org in the URL is open; the others are open
 * too while the user has fewer than three orgs, and collapsed from three on.
 */
export function orgSectionCollapsed({
  stored,
  serverCollapsed,
  active,
  orgCount,
}: OrgSectionInput): boolean {
  if (stored) return stored === 'closed';
  if (serverCollapsed) return true;
  if (active) return false;
  return orgCount >= collapseOrgsFrom;
}

/** All organisations is open unless collapsed on this browser (it has no server pref). */
export function allSectionCollapsed(stored: SectionState | null): boolean {
  return stored === 'closed';
}
