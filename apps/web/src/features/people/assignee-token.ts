import { findAssigneeToken, matchMembers } from '@rooster/core/dates';
import type { Person } from './members';

/**
 * `@name` on inline create (02 §3.4, shared orgs): the web side of core's `findAssigneeToken`,
 * which the server's `parse: true` uses too, so both read a title the same way. The token is
 * `@Name` or `@"Full name"`, last in the title (only a date phrase may follow); a token that
 * names nobody, or several people, stays text.
 */

interface Span {
  start: number;
  end: number;
}

export interface AssigneeTokenHit extends Span {
  userId: string;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** The `@name` token that assigns the task on commit, unless cancelled (`ignored`). */
export function resolveAssigneeToken(
  text: string,
  members: readonly Person[],
  viewerId: string,
  ignored: readonly Span[] = [],
): AssigneeTokenHit | null {
  if (members.length === 0) return null;
  const hit = findAssigneeToken(text, members, viewerId);
  if (!hit?.userId || ignored.some((span) => overlaps(span, hit))) return null;
  return { start: hit.start, end: hit.end, userId: hit.userId };
}

/** The members a typed `@query` can mean, best first (core's ranking). */
export function suggestMembers<T extends Person>(
  query: string,
  members: readonly T[],
  viewerId: string,
): T[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  return matchMembers(query, members, viewerId).flatMap((m) => {
    const member = byId.get(m.userId);
    return member ? [member] : [];
  });
}

/**
 * What the autocomplete inserts: `@Anna` when the first name alone names this member, else
 * `@"Anna Lindqvist"`.
 */
export function memberHandle(member: Person, members: readonly Person[]): string {
  const first = member.name.trim().split(/\s+/)[0] ?? '';
  const matches = matchMembers(first, members);
  if (/^\p{L}\S*$/u.test(first) && matches.length === 1 && matches[0]?.userId === member.userId) {
    return `@${first}`;
  }
  return `@"${member.name.replace(/["\n]/g, '').trim()}"`;
}
