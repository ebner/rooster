import type { DueContext } from './dates/index.ts';
import type { Tag, Task } from './schemas/index.ts';
import { inSmartView, type SmartView } from './views.ts';

/**
 * Search query grammar (01 FR-VIEW-3, 02 §12), shared by the server's FTS5 search and the web
 * palette (online results and offline filtering over cached tasks).
 *
 * - Free words are terms; each becomes a prefix match (`tand` matches `tandläkare`). Matching
 *   ignores case and diacritics, like the FTS5 `unicode61 remove_diacritics 2` tokenizer.
 * - `#tag` filters by tag name (prefix, case-insensitive), `@person` by assignee (P6 data; the
 *   name, email or `me`), `due:today|overdue|week|none` by due state, `is:open|done` by status.
 * - A leading `>` limits the palette to actions; the rest of the query fuzzy-matches them.
 * - Double quotes keep a phrase together as one term.
 *
 * Details (ADR 0012):
 * - Filter keys and values are case- and diacritic-insensitive. Swedish aliases are accepted:
 *   `due:idag|försenade|försenad|vecka|inget|ingen|utan`, `is:öppen|öppna|klar|klara`.
 * - `due:` filters mirror the smart views: `today` = due today or earlier (the Today view),
 *   `week` = today … today + 6, `overdue` = past due (timed: once the instant passed), `none` =
 *   no due date. Completed tasks are classified as if open.
 * - Several `#tag` filters AND-combine; several `@person` filters OR-combine (a task has one
 *   assignee). The last `due:` and `is:` win.
 * - A bare `#`, `@`, `due:` or `is:` (the user is still typing) is ignored. An unknown key or
 *   value (`foo:bar`, `due:soon`) is a plain term. A quoted token (`"due:today"`) is always a term;
 *   quotes also work inside filters (`#"two words"`).
 * - A term without any letter or digit (`!!!`) cannot match an FTS5 token, so it is dropped.
 */

export const SEARCH_DUE_FILTERS = ['today', 'overdue', 'week', 'none'] as const;
export type SearchDueFilter = (typeof SEARCH_DUE_FILTERS)[number];

export interface ParsedSearchQuery {
  /** `>` prefix: actions only (palette). */
  actionsOnly: boolean;
  /** Lower-cased, diacritics kept; phrase terms keep their spaces. */
  terms: string[];
  tags: string[];
  people: string[];
  due: SearchDueFilter | null;
  /** Default `any`: search ranks open tasks first but includes completed ones. */
  status: 'open' | 'done' | 'any';
  /** The query text without filters and prefix (what the palette fuzzy-matches actions on). */
  text: string;
}

// Maps, not object literals: user input like `due:constructor` must not hit the prototype.
const DUE_VALUES = new Map<string, SearchDueFilter>([
  ['today', 'today'],
  ['overdue', 'overdue'],
  ['week', 'week'],
  ['none', 'none'],
  ['idag', 'today'],
  ['forsenade', 'overdue'],
  ['forsenad', 'overdue'],
  ['vecka', 'week'],
  ['inget', 'none'],
  ['ingen', 'none'],
  ['utan', 'none'],
]);

const STATUS_VALUES = new Map<string, 'open' | 'done'>([
  ['open', 'open'],
  ['done', 'done'],
  ['oppen', 'open'],
  ['oppna', 'open'],
  ['klar', 'done'],
  ['klara', 'done'],
]);

const DUE_VIEW: Readonly<Record<SearchDueFilter, SmartView>> = {
  today: 'today',
  overdue: 'overdue',
  week: 'week',
  none: 'nodate',
};

const CONTROL_CHARS = /\p{Cc}/gu;
const COMBINING_MARKS = /\p{M}/gu;
const WORD_SEPARATORS = /[^\p{L}\p{N}]+/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Case- and diacritic-folded text (`Tandläkare` → `tandlakare`), for matching only. */
export function foldText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/** The folded words of a text, split like the FTS5 `unicode61` tokenizer (letters and digits). */
export function searchWords(value: string): string[] {
  return foldText(value)
    .split(WORD_SEPARATORS)
    .filter((word) => word !== '');
}

interface Token {
  value: string;
  /** Started with a double quote: always a term. */
  quoted: boolean;
}

/** Splits on whitespace; a double quote opens a run (spaces included) until the next one. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let value = '';
  let quoted = false;
  let inQuotes = false;
  let started = false;
  const flush = () => {
    if (started) tokens.push({ value, quoted });
    value = '';
    quoted = false;
    started = false;
  };
  for (const char of input) {
    if (char === '"') {
      if (!started) quoted = true;
      started = true;
      inQuotes = !inQuotes;
    } else if (!inQuotes && /\s/u.test(char)) {
      flush();
    } else {
      value += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

export function parseSearchQuery(q: string): ParsedSearchQuery {
  let rest = q.replace(CONTROL_CHARS, ' ').trim();
  const actionsOnly = rest.startsWith('>');
  if (actionsOnly) rest = rest.slice(1);

  const parsed: ParsedSearchQuery = {
    actionsOnly,
    terms: [],
    tags: [],
    people: [],
    due: null,
    status: 'any',
    text: '',
  };
  const text: string[] = [];
  const addTerm = (value: string) => {
    const term = value.trim().replace(/\s+/gu, ' ');
    if (term === '') return;
    text.push(term);
    if (WORD_CHAR.test(term)) parsed.terms.push(term.toLowerCase());
  };

  for (const { value, quoted } of tokenize(rest)) {
    if (quoted) {
      addTerm(value);
      continue;
    }
    const sigil = value[0];
    if (sigil === '#' || sigil === '@') {
      const name = value.slice(1).trim().replace(/\s+/gu, ' ').toLowerCase();
      if (name !== '') (sigil === '#' ? parsed.tags : parsed.people).push(name);
      continue;
    }
    const colon = value.indexOf(':');
    if (colon > 0) {
      const key = foldText(value.slice(0, colon));
      const option = foldText(value.slice(colon + 1)).trim();
      if ((key === 'due' || key === 'is') && option === '') continue;
      const due = key === 'due' ? DUE_VALUES.get(option) : undefined;
      if (due) {
        parsed.due = due;
        continue;
      }
      const status = key === 'is' ? STATUS_VALUES.get(option) : undefined;
      if (status) {
        parsed.status = status;
        continue;
      }
    }
    addTerm(value);
  }
  parsed.text = text.join(' ');
  return parsed;
}

/**
 * The FTS5 MATCH expression for the terms (each a quoted prefix query, AND-combined), or null
 * when there are no terms (a filter-only query). Quotes inside terms are escaped.
 *
 * Inside an FTS5 string only `"` is special, so operators (`AND`, `NEAR`, `-`, `:`, `*`, `(`)
 * in a term are plain text. A multi-word term is a phrase whose last word is the prefix.
 */
export function toFtsMatch(terms: readonly string[]): string | null {
  const parts: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(CONTROL_CHARS, ' ');
    // A string without tokens matches nothing and would empty the whole AND.
    if (!WORD_CHAR.test(term)) continue;
    parts.push(`"${term.replaceAll('"', '""')}"*`);
  }
  return parts.length === 0 ? null : parts.join(' AND ');
}

export interface LocalSearchContext extends DueContext {
  viewerId: string;
  tagsById: Readonly<Record<string, Tag>>;
  /** For `@person`; without it only `@me` matches offline. */
  membersById?: Readonly<Record<string, { name: string; email: string }>>;
}

/** Whether `words` contains `phrase` with its last word as a prefix (FTS5 `"a b"*`). */
function containsPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  const last = phrase.length - 1;
  if (last < 0) return true;
  for (let start = 0; start + last < words.length; start++) {
    let matches = true;
    for (let i = 0; i < last && matches; i++) matches = words[start + i] === phrase[i];
    if (matches && words[start + last]?.startsWith(phrase[last] as string)) return true;
  }
  return false;
}

function personMatches(
  filter: string,
  assigneeId: string | null,
  ctx: Pick<LocalSearchContext, 'viewerId' | 'membersById'>,
): boolean {
  if (assigneeId === null) return false;
  if (filter === 'me') return assigneeId === ctx.viewerId;
  const member = ctx.membersById?.[assigneeId];
  if (!member) return false;
  const wanted = foldText(filter);
  const name = foldText(member.name);
  return (
    name.startsWith(wanted) ||
    foldText(member.email).startsWith(wanted) ||
    searchWords(member.name).some((word) => word.startsWith(wanted))
  );
}

/**
 * The filter part of `matchesTask` (`#tag`, `@person`, `due:`, `is:`), without the terms: the
 * server applies it after its FTS5 match so online and offline filters agree.
 */
export function matchesFilters(
  task: Task,
  query: ParsedSearchQuery,
  ctx: LocalSearchContext,
): boolean {
  if (query.status === 'open' && task.completedAt !== null) return false;
  if (query.status === 'done' && task.completedAt === null) return false;
  if (query.due !== null && !inSmartView(task, DUE_VIEW[query.due], ctx)) return false;
  if (query.tags.length > 0) {
    const names = task.tagIds.flatMap((id) => {
      const tag = ctx.tagsById[id];
      return tag ? [foldText(tag.name)] : [];
    });
    for (const filter of query.tags) {
      const wanted = foldText(filter);
      if (!names.some((name) => name.startsWith(wanted))) return false;
    }
  }
  if (query.people.length > 0) {
    return query.people.some((filter) => personMatches(filter, task.assigneeId, ctx));
  }
  return true;
}

/**
 * Offline search: whether a cached task matches the parsed query (terms as prefixes of any word
 * in the title; filters as above). Descriptions are not in the list cache, so offline search
 * covers titles only.
 */
export function matchesTask(
  task: Task,
  query: ParsedSearchQuery,
  ctx: LocalSearchContext,
): boolean {
  if (task.deletedAt !== undefined && (task.deletedAt as number | null) !== null) return false;
  if (!matchesFilters(task, query, ctx)) return false;
  if (query.terms.length === 0) return true;
  const words = searchWords(task.title);
  return query.terms.every((term) => containsPhrase(words, searchWords(term)));
}

const SCORE_MATCH = 1;
const SCORE_WORD_START = 8;
const SCORE_FIRST_CHAR = 2;
/** Minimum bonus of a character that continues a run; a run started at a word start keeps that. */
const SCORE_CONSECUTIVE = 5;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
/** Breaks ties in favour of shorter labels without outweighing any real bonus. */
const PENALTY_LENGTH = 0.001;

interface FoldedChar {
  char: string;
  wordStart: boolean;
}

function foldLabel(label: string): FoldedChar[] {
  const out: FoldedChar[] = [];
  let previous = '';
  for (const char of label) {
    const isWord = WORD_CHAR.test(char);
    const wordStart =
      isWord &&
      (previous === '' ||
        !WORD_CHAR.test(previous) ||
        (/\p{Ll}/u.test(previous) && /\p{Lu}/u.test(char)));
    let first = true;
    for (const folded of foldText(char)) {
      out.push({ char: folded, wordStart: wordStart && first });
      first = false;
    }
    previous = char;
  }
  return out;
}

/**
 * Palette action matching: a subsequence fuzzy score of `query` against `label` (higher is
 * better; null = no match). Word starts and consecutive characters score higher.
 *
 * Case, diacritics and whitespace in the query are ignored; an empty query scores 0. Scoring
 * follows fzf: a word start (after a separator, or a camelCase hump) earns a bonus, a character
 * continuing a run earns the run's starting bonus (at least `SCORE_CONSECUTIVE`), and a gap costs
 * a start penalty plus one per extra skipped character (leading characters are free). The best
 * alignment is found by dynamic programming, O(|query| · |label|).
 */
export function fuzzyScore(query: string, label: string): number | null {
  const needle = [...foldText(query).replace(/\s+/gu, '')];
  if (needle.length === 0) return 0;
  const hay = foldLabel(label);
  if (needle.length > hay.length) return null;

  const boundary = hay.map(
    (h, j) => (h.wordStart ? SCORE_WORD_START : 0) + (j === 0 ? SCORE_FIRST_CHAR : 0),
  );
  // score[j]: the best score with the current query char matched at label index j; run[j]: the
  // bonus of the run that match belongs to.
  let score = hay.map((h, j) =>
    h.char === needle[0] ? SCORE_MATCH + (boundary[j] as number) : -Infinity,
  );
  let run = boundary.slice();
  for (let i = 1; i < needle.length; i++) {
    const nextScore = new Array<number>(hay.length).fill(-Infinity);
    const nextRun = new Array<number>(hay.length).fill(0);
    // The best previous match at least one character back, net of its gap penalty at j.
    let gapped = -Infinity;
    for (let j = 1; j < hay.length; j++) {
      if (j >= 2) {
        gapped = Math.max(
          gapped - PENALTY_GAP_EXTENSION,
          (score[j - 2] as number) - PENALTY_GAP_START,
        );
      }
      if (hay[j]?.char !== needle[i]) continue;
      const own = boundary[j] as number;
      const runBonus = Math.max(own, run[j - 1] as number, SCORE_CONSECUTIVE);
      const consecutive = (score[j - 1] as number) + SCORE_MATCH + runBonus;
      const afterGap = gapped + SCORE_MATCH + own;
      if (consecutive >= afterGap && consecutive > -Infinity) {
        nextScore[j] = consecutive;
        nextRun[j] = runBonus;
      } else if (afterGap > -Infinity) {
        nextScore[j] = afterGap;
        nextRun[j] = own;
      }
    }
    score = nextScore;
    run = nextRun;
  }
  const best = Math.max(...score);
  return best === -Infinity ? null : best - hay.length * PENALTY_LENGTH;
}
