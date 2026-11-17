import type { SavedViewQuery, Tag } from '@rooster/core/schemas';
import type { ParsedSearchQuery } from '@rooster/core/search';
import type { DueFilter } from '../people/everyone-model';
import type { Person } from '../people/members';

/**
 * Phase 13 (ADR 0073 B2): a view's query as the header edits it, and the queries "Save as view"
 * makes from the list filters and the palette's search grammar.
 */

/** VIEW_NAME_MAX and VIEW_TAGS_MAX of `@rooster/core/schemas` (zod stays off this route). */
export const viewNameMax = 60;
export const viewTagsMax = 20;

export const viewDueFilters = ['any', 'today', 'week', 'overdue', 'none'] as const;
export const viewStatusFilters = ['open', 'done', 'any'] as const;
export type ViewDue = (typeof viewDueFilters)[number];
export type ViewStatus = (typeof viewStatusFilters)[number];

/** A new view shows everything open: no tags, anyone, any date. */
export const emptyViewQuery: SavedViewQuery = {
  tags: [],
  tagMode: 'any',
  assignee: 'anyone',
  due: 'any',
  status: 'open',
};

/** The person filter a query names (`me`, `unassigned`, a member), or null for anyone. */
export function assigneeKind(
  query: Pick<SavedViewQuery, 'assignee'>,
): 'anyone' | 'me' | 'unassigned' | 'member' {
  const { assignee } = query;
  return assignee === 'anyone' || assignee === 'me' || assignee === 'unassigned'
    ? assignee
    : 'member';
}

/** Whether a query filters anything at all (else it would list every open task). */
export function isFiltered(query: SavedViewQuery): boolean {
  return (
    query.tags.length > 0 ||
    query.assignee !== 'anyone' ||
    query.due !== 'any' ||
    query.status !== 'open'
  );
}

export interface NameContext {
  tags: readonly Pick<Tag, 'id' | 'name'>[];
  members: readonly Pick<Person, 'userId' | 'name'>[];
  /** Localised labels for the filters other than tags. */
  label: {
    me: string;
    unassigned: string;
    due: (due: Exclude<ViewDue, 'any'>) => string;
    status: (status: Exclude<ViewStatus, 'open'>) => string;
    fallback: string;
  };
}

/**
 * A name for a view saved from a filter (B7): its tags ("Juniper", "Juniper, Fika"), else its
 * other filters ("Anna · Overdue"); renamed in the header right after.
 */
export function suggestViewName(query: SavedViewQuery, ctx: NameContext): string {
  const tags = query.tags
    .map((id) => ctx.tags.find((tag) => tag.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(', '));
  else {
    if (query.assignee === 'me') parts.push(ctx.label.me);
    else if (query.assignee === 'unassigned') parts.push(ctx.label.unassigned);
    else if (query.assignee !== 'anyone') {
      const name = ctx.members.find((m) => m.userId === query.assignee)?.name;
      if (name) parts.push(name);
    }
    if (query.due !== 'any') parts.push(ctx.label.due(query.due));
    if (query.status !== 'open') parts.push(ctx.label.status(query.status));
  }
  const name = parts.join(' · ').trim() || ctx.label.fallback;
  return [...name].slice(0, viewNameMax).join('');
}

/** Everyone's due filter (02 §11) as a view's. */
const dueOfEveryone: Readonly<Record<DueFilter, ViewDue>> = {
  any: 'any',
  overdue: 'overdue',
  week: 'week',
  nodate: 'none',
};

/**
 * Everyone's tasks' filters as a view (B7): the tag filter (any of them), the due filter, and
 * the member filter when it names one person (several can't be one view's; they become anyone).
 */
export function queryFromEveryone(filters: {
  tagIds: readonly string[];
  due: DueFilter;
  members: readonly (string | null)[];
}): SavedViewQuery {
  const one = filters.members.length === 1 ? filters.members[0] : undefined;
  return {
    ...emptyViewQuery,
    tags: filters.tagIds.slice(0, viewTagsMax),
    due: dueOfEveryone[filters.due],
    assignee: one === undefined ? 'anyone' : one === null ? 'unassigned' : one,
  };
}

/**
 * My tasks' tag filter as a view (B7): the tags, across people (the view a project lives in;
 * the assignee chip narrows it to me).
 */
export function queryFromTagFilter(tagIds: readonly string[]): SavedViewQuery {
  return { ...emptyViewQuery, tags: tagIds.slice(0, viewTagsMax) };
}

/** Whether a palette query filters tasks (`#tag`, `@person`, `due:`, `is:`). */
export function searchHasFilters(parsed: ParsedSearchQuery): boolean {
  return (
    !parsed.actionsOnly &&
    (parsed.tags.length > 0 ||
      parsed.people.length > 0 ||
      parsed.due !== null ||
      parsed.status !== 'any')
  );
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();

/**
 * A palette search as a view of an org (B7): `#tag` names resolve to the org's tags (unknown
 * ones are left out), one `@person` to a member (`@me` to `me`), `due:` and `is:` as they are.
 * Free text has no place in a view (B2) and is dropped. Null when nothing of it applies.
 */
export function queryFromSearch(
  parsed: ParsedSearchQuery,
  ctx: {
    tags: readonly Pick<Tag, 'id' | 'name'>[];
    members: readonly Pick<Person, 'userId' | 'name' | 'email'>[];
  },
): SavedViewQuery | null {
  const tags: string[] = [];
  for (const name of parsed.tags) {
    const tag = ctx.tags.find((t) => fold(t.name) === fold(name));
    if (tag && !tags.includes(tag.id)) tags.push(tag.id);
  }
  let assignee: SavedViewQuery['assignee'] = 'anyone';
  if (parsed.people.length === 1) {
    const who = fold(parsed.people[0] as string);
    if (who === 'me') assignee = 'me';
    else {
      const member = ctx.members.find(
        (m) =>
          fold(m.name) === who ||
          fold(m.email) === who ||
          fold(m.name)
            .split(/\s+/)
            .some((word) => word === who),
      );
      if (member) assignee = member.userId;
    }
  }
  const query: SavedViewQuery = {
    ...emptyViewQuery,
    tags: tags.slice(0, viewTagsMax),
    // The search wants every `#tag` it names (the list filters are any of them).
    tagMode: tags.length > 1 ? 'all' : 'any',
    assignee,
    due: parsed.due ?? 'any',
    status: parsed.status === 'any' ? 'open' : parsed.status,
  };
  return isFiltered(query) ? query : null;
}
