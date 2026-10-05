import { descendantIds, type ListState } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@rooster/core/schemas';
import {
  foldText,
  fuzzyScore,
  type LocalSearchContext,
  matchesTask,
  type ParsedSearchQuery,
  searchWords,
} from '@rooster/core/search';
import type { PaletteGroup, ShortcutId } from '../../keymap';

/**
 * The palette's pure model (02 §12): which sections and items a query shows. The panel renders
 * it; the container feeds it the search results, the cache and the registry's actions.
 */

/** A run of text, highlighted (`mark`) where it matched the query. */
export interface Segment {
  text: string;
  mark: boolean;
}

/** What a task row shows; recents may only know the stored title. */
export type TaskSummary = Pick<
  Task,
  'id' | 'title' | 'dueDate' | 'dueTime' | 'dueTz' | 'startDate' | 'completedAt'
>;

export interface TaskItem {
  kind: 'task';
  key: string;
  task: TaskSummary;
  orgId: string;
  /** The title with the matched words marked. */
  title: Segment[];
  /** Where the match is outside the title (description, comments), the excerpt; else null. */
  snippet: Segment[] | null;
  /** The group (current org) or the org (another org). */
  chip: string | null;
}

export interface ActionItem {
  kind: 'action';
  key: string;
  /** The registry entry the action runs (`runShortcut`). */
  commandId: ShortcutId;
  group: PaletteGroup;
  label: string;
  /** The registry's first binding (`Kbd` format); null for palette-only commands. */
  shortcut: string | null;
  /** Extra run arguments, e.g. the digit of `goToOrg`. */
  args?: { key: string; code: string } | undefined;
  /** Navigation that is not a registry key (an org past the ninth). */
  href?: string | undefined;
}

export type PaletteItem = TaskItem | ActionItem;

export type SectionId = 'recent' | 'tasks' | 'actions';

export interface PaletteSection {
  id: SectionId;
  items: PaletteItem[];
}

/** Empty query: Actions after the recents, task actions (for the selection) first. */
const groupOrder: readonly PaletteGroup[] = ['task', 'list', 'navigation', 'general'];

/** With tasks on screen, only the best few actions follow them. */
export const mixedActionsMax = 5;
export const tasksMax = 50;

/** Splits a server snippet on the highlight markers (`SNIPPET_MARK_START` … `_END`). */
export function splitSnippet(snippet: string): Segment[] {
  const out: Segment[] = [];
  let mark = false;
  let text = '';
  const push = () => {
    if (text !== '') {
      const last = out.at(-1);
      if (last && last.mark === mark) last.text += text;
      else out.push({ text, mark });
    }
    text = '';
  };
  for (const char of snippet) {
    if (char === SNIPPET_MARK_START || char === SNIPPET_MARK_END) {
      push();
      mark = char === SNIPPET_MARK_START;
    } else {
      text += char;
    }
  }
  push();
  return out;
}

export function plainText(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('');
}

/** The shortest prefix of `word` whose folded form covers `foldedLength` characters. */
function prefixLength(word: string, foldedLength: number): number {
  const chars = [...word];
  for (let i = 1; i <= chars.length; i++) {
    if (foldText(chars.slice(0, i).join('')).length >= foldedLength) {
      return chars.slice(0, i).join('').length;
    }
  }
  return word.length;
}

/**
 * Marks the word prefixes of `title` that the query terms match, the way the search does
 * (case- and diacritic-insensitive prefixes): offline results and recents get the same
 * highlights as the server's snippets.
 */
export function highlightTerms(title: string, terms: readonly string[]): Segment[] {
  const words = terms.flatMap((term) => searchWords(term));
  if (words.length === 0) return title ? [{ text: title, mark: false }] : [];
  const out: Segment[] = [];
  let cursor = 0;
  for (const match of title.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const start = match.index;
    const folded = foldText(word);
    const best = Math.max(0, ...words.map((w) => (folded.startsWith(w) ? w.length : 0)));
    if (best === 0) continue;
    const end = start + prefixLength(word, best);
    if (start > cursor) out.push({ text: title.slice(cursor, start), mark: false });
    out.push({ text: title.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < title.length) out.push({ text: title.slice(cursor), mark: false });
  return out;
}

/** Actions matching `text` best first (fuzzy, 04 §5.3); all of them, in group order, when empty. */
export function rankActions(actions: readonly ActionItem[], text: string): ActionItem[] {
  const query = text.trim();
  if (query === '') {
    return groupOrder.flatMap((group) => actions.filter((a) => a.group === group));
  }
  return actions
    .flatMap((action, index) => {
      const score = fuzzyScore(query, action.label);
      return score === null ? [] : [{ action, score, index }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.action);
}

export interface SectionsInput {
  query: string;
  parsed: ParsedSearchQuery;
  recents: readonly TaskItem[];
  tasks: readonly TaskItem[];
  actions: readonly ActionItem[];
  /** `/` (search mode): no actions unless the query asks for them with `>`. */
  searchMode?: boolean;
}

/**
 * 02 §12. Empty: recent tasks, then the actions. `>`: actions only, fuzzy-matched. Otherwise the
 * task results, then the few actions that match the free text.
 */
export function buildSections({
  query,
  parsed,
  recents,
  tasks,
  actions,
  searchMode = false,
}: SectionsInput): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const add = (id: SectionId, items: readonly PaletteItem[]) => {
    if (items.length > 0) sections.push({ id, items: [...items] });
  };
  if (parsed.actionsOnly) {
    add('actions', rankActions(actions, parsed.text));
    return sections;
  }
  if (query.trim() === '') {
    add('recent', recents);
    if (!searchMode) add('actions', rankActions(actions, ''));
    return sections;
  }
  add('tasks', tasks.slice(0, tasksMax));
  if (!searchMode && parsed.text !== '') {
    const ranked = rankActions(actions, parsed.text);
    add('actions', tasks.length > 0 ? ranked.slice(0, mixedActionsMax) : ranked);
  }
  return sections;
}

export function flatItems(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}

/** Keeps the active item when it is still listed, else the first one. */
export function nextActiveKey(
  sections: readonly PaletteSection[],
  previous: string | null,
): string | null {
  const items = flatItems(sections);
  if (previous && items.some((i) => i.key === previous)) return previous;
  return items[0]?.key ?? null;
}

/** ↑/↓ over every item across sections, wrapping at the ends. */
export function stepActiveKey(
  sections: readonly PaletteSection[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  const items = flatItems(sections);
  if (items.length === 0) return null;
  const index = items.findIndex((i) => i.key === current);
  if (index < 0) return (delta === 1 ? items[0] : items.at(-1))?.key ?? null;
  return items[(index + delta + items.length) % items.length]?.key ?? null;
}

export interface CachedSearchOptions {
  /** Only this org; null: every cached org. */
  orgId: string | null;
  /** Tasks never offered (the "Make subtask of…" selection and its descendants). */
  exclude?: ReadonlySet<string> | undefined;
  limit?: number;
}

/**
 * Offline search (02 §12, FR-PWA-2): the cached My tasks lists filtered with the shared
 * grammar. Titles only (the list cache has no descriptions). Open tasks first, then the most
 * recently changed.
 */
export function searchCachedTasks(
  lists: readonly ListState[],
  parsed: ParsedSearchQuery,
  ctx: LocalSearchContext,
  { orgId, exclude, limit = tasksMax }: CachedSearchOptions,
): Task[] {
  const found: Task[] = [];
  for (const list of lists) {
    if (orgId !== null && list.orgId !== orgId) continue;
    for (const task of Object.values(list.tasks)) {
      if (exclude?.has(task.id)) continue;
      if (matchesTask(task, parsed, ctx)) found.push(task);
    }
  }
  return found
    .sort(
      (a, b) =>
        Number(a.completedAt !== null) - Number(b.completedAt !== null) ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, limit);
}

/** The selection and every descendant: a task cannot become a subtask of its own subtree. */
export function subtreeOf(list: ListState | undefined, ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  if (!list) return out;
  for (const id of ids) for (const d of descendantIds(list, id)) out.add(d);
  return out;
}

/** A task by ID in any cached list (open or completed, not deleted). */
export function findCachedTask(lists: readonly ListState[], id: string): Task | undefined {
  for (const list of lists) {
    const task = list.tasks[id];
    if (task) return task;
  }
  return undefined;
}
