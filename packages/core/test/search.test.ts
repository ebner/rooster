import { describe, expect, it } from 'vitest';
import { todayIn } from '../src/dates.ts';
import type { Tag, Task } from '../src/schemas/index.ts';
import {
  foldText,
  fuzzyScore,
  type LocalSearchContext,
  matchesFilters,
  matchesTask,
  type ParsedSearchQuery,
  parseSearchQuery,
  searchWords,
  toFtsMatch,
} from '../src/search.ts';

const ME = 'user-me';
const ANNA = 'user-anna';
const viewerTz = 'Europe/Stockholm';
const nowMs = Date.UTC(2026, 9, 5, 8, 0); // 2026-10-05 10:00 Stockholm

const tag = (id: string, name: string): Tag => ({
  id,
  orgId: 'org',
  name,
  color: 'blue',
  createdAt: 1,
});

const ctx: LocalSearchContext = {
  today: todayIn(viewerTz, nowMs),
  nowMs,
  viewerTz,
  viewerId: ME,
  tagsById: { t1: tag('t1', 'Ärende'), t2: tag('t2', 'Home office'), t3: tag('t3', 'urgent') },
  membersById: {
    [ME]: { name: 'Jannik Lunde', email: 'jannik@example.com' },
    [ANNA]: { name: 'Anna Ölund', email: 'anna.o@example.com' },
  },
};

function task(title: string, extra: Partial<Task> = {}): Task {
  return {
    id: 'task',
    orgId: 'org',
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title,
    assigneeId: ME,
    createdBy: ME,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

const parsed = (overrides: Partial<ParsedSearchQuery>): ParsedSearchQuery => ({
  actionsOnly: false,
  terms: [],
  tags: [],
  people: [],
  due: null,
  status: 'any',
  text: '',
  ...overrides,
});

describe('parseSearchQuery', () => {
  it.each<[string, Partial<ParsedSearchQuery>]>([
    ['', {}],
    ['   ', {}],
    ['Tand', { terms: ['tand'], text: 'Tand' }],
    ['boka  Tandläkare', { terms: ['boka', 'tandläkare'], text: 'boka Tandläkare' }],
    ['"Weekly  report" draft', { terms: ['weekly report', 'draft'], text: 'Weekly report draft' }],
    ['"unterminated phrase', { terms: ['unterminated phrase'], text: 'unterminated phrase' }],
    ['""', {}],
    ['#Work #"home office"', { tags: ['work', 'home office'] }],
    ['@me @Anna', { people: ['me', 'anna'] }],
    ['# @ due: is:', {}],
    ['due:today', { due: 'today' }],
    ['DUE:Overdue', { due: 'overdue' }],
    ['due:week due:none', { due: 'none' }],
    ['due:idag', { due: 'today' }],
    ['due:försenade', { due: 'overdue' }],
    ['due:forsenad', { due: 'overdue' }],
    ['due:vecka', { due: 'week' }],
    ['due:inget', { due: 'none' }],
    ['is:open', { status: 'open' }],
    ['is:done', { status: 'done' }],
    ['is:klar', { status: 'done' }],
    ['is:öppna', { status: 'open' }],
    ['due:soon', { terms: ['due:soon'], text: 'due:soon' }],
    ['due:constructor', { terms: ['due:constructor'], text: 'due:constructor' }],
    ['is:__proto__', { terms: ['is:__proto__'], text: 'is:__proto__' }],
    ['foo:bar', { terms: ['foo:bar'], text: 'foo:bar' }],
    [':colon', { terms: [':colon'], text: ':colon' }],
    ['"due:today"', { terms: ['due:today'], text: 'due:today' }],
    ['!!! ok', { terms: ['ok'], text: '!!! ok' }],
    ['a\u0000b', { terms: ['a', 'b'], text: 'a b' }],
    [
      'rapport #urgent due:week is:open @me',
      {
        terms: ['rapport'],
        tags: ['urgent'],
        due: 'week',
        status: 'open',
        people: ['me'],
        text: 'rapport',
      },
    ],
  ])('%j', (q, expected) => {
    expect(parseSearchQuery(q)).toEqual(parsed(expected));
  });

  it('a leading > limits to actions and is not part of the text', () => {
    expect(parseSearchQuery('> New Task')).toEqual(
      parsed({ actionsOnly: true, terms: ['new', 'task'], text: 'New Task' }),
    );
    expect(parseSearchQuery('>')).toEqual(parsed({ actionsOnly: true }));
    expect(parseSearchQuery('a > b').actionsOnly).toBe(false);
  });
});

describe('toFtsMatch', () => {
  it.each<[string[], string | null]>([
    [[], null],
    [['!!!', '   '], null],
    [['tand'], '"tand"*'],
    [['boka', 'tand'], '"boka"* AND "tand"*'],
    [['weekly report'], '"weekly report"*'],
    [['say "hi"'], '"say ""hi"""*'],
    [['a\u0000b'], '"a b"*'],
    [['NEAR(a b)', 'x OR y'], '"NEAR(a b)"* AND "x OR y"*'],
  ])('%j → %s', (terms, expected) => {
    expect(toFtsMatch(terms)).toBe(expected);
  });
});

/** Random user input with FTS5 syntax, quotes, unicode and control characters. */
function randomQueries(count: number): string[] {
  const pieces = [
    '"',
    '""',
    '*',
    ':',
    '(',
    ')',
    'NEAR',
    'AND',
    'OR',
    'NOT',
    '-',
    '^',
    '+',
    '{',
    '}',
    ' ',
    'tand',
    'läkare',
    'Ö',
    'ß',
    '日本',
    '🐓',
    '́',
    '\u0000',
    '\n',
    '\t',
    '#',
    '@',
    'due:',
    'is:',
    '>',
    "'",
    '\\',
    '%',
    '_',
    'title:',
    'x',
    '1',
  ];
  let seed = 42;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  return Array.from({ length: count }, () => {
    const n = 1 + Math.floor(random() * 8);
    return Array.from({ length: n }, () => pieces[Math.floor(random() * pieces.length)]).join('');
  });
}

describe('toFtsMatch fuzzing', () => {
  const queries = randomQueries(2_000);

  it('never throws and always quotes every term', () => {
    for (const q of queries) {
      const match = toFtsMatch(parseSearchQuery(q).terms);
      if (match !== null) expect(match).toMatch(/^"(?:[^"]|"")*"\*(?: AND "(?:[^"]|"")*"\*)*$/s);
    }
  });

  it('every generated expression is valid FTS5 (unicode61 remove_diacritics 2)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(title, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4')",
    );
    db.prepare('INSERT INTO t (title) VALUES (?)').run('Boka tandläkare');
    const select = db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?');
    for (const q of queries) {
      const match = toFtsMatch(parseSearchQuery(q).terms);
      if (match !== null) expect(() => select.get(match), q).not.toThrow();
    }
    // AC-5.2: prefix and diacritic-insensitive, like matchesTask.
    for (const q of ['tand', 'Tand', 'boka tand', 'tandlakare', '"boka tand"']) {
      expect(select.get(toFtsMatch(parseSearchQuery(q).terms))).toEqual({ n: 1 });
    }
    for (const q of ['läkare boka x', '"tand boka"']) {
      expect(select.get(toFtsMatch(parseSearchQuery(q).terms))).toEqual({ n: 0 });
    }
    db.close();
  });
});

const { membersById: _members, ...withoutMembers } = ctx;

describe('matchesTask (offline, titles only)', () => {
  const matches = (q: string, t: Task) => matchesTask(t, parseSearchQuery(q), ctx);

  it.each<[string, string, boolean]>([
    ['tand', 'Boka tandläkare', true],
    ['TAND', 'Boka tandläkare', true],
    ['tandlakare', 'Boka Tandläkare', true],
    ['rapport', 'Rapport Q3', true],
    ['läkare', 'Boka tandläkare', false],
    ['boka tand', 'Boka tandläkare', true],
    ['tand boka', 'Boka tandläkare', true],
    ['tand kaffe', 'Boka tandläkare', false],
    ['"boka tand"', 'Boka tandläkare', true],
    ['"tand boka"', 'Boka tandläkare', false],
    ['"boka tandläkare idag"', 'Boka tandläkare', false],
    ['e-post', 'Svara på e-post', true],
    ['e-po', 'Svara på e-post', true],
    ['', 'Anything', true],
    ['!!!', 'Anything', true],
  ])('%j in %j → %s', (q, title, expected) => {
    expect(matches(q, task(title))).toBe(expected);
  });

  it('never matches a deleted task', () => {
    expect(matches('boka', task('Boka', { deletedAt: 5 }))).toBe(false);
    const row = { ...task('Boka'), deletedAt: null } as unknown as Task;
    expect(matches('boka', row)).toBe(true);
  });

  it('AND-combines #tag filters by name prefix, ignoring case and diacritics', () => {
    const t = task('Plan', { tagIds: ['t1', 't2', 'missing'] });
    expect(matches('#ärende', t)).toBe(true);
    expect(matches('#arende #home', t)).toBe(true);
    expect(matches('#HOME #urgent', t)).toBe(false);
    expect(matches('#office', t)).toBe(false);
  });

  it('OR-combines @person filters: me, name word prefix or email prefix', () => {
    const mine = task('Plan');
    const annas = task('Plan', { assigneeId: ANNA });
    expect(matches('@me', mine)).toBe(true);
    expect(matches('@me', annas)).toBe(false);
    expect(matches('@anna', annas)).toBe(true);
    expect(matches('@olund', annas)).toBe(true);
    expect(matches('@anna.o', annas)).toBe(true);
    expect(matches('@"anna ö"', annas)).toBe(true);
    expect(matches('@bob', annas)).toBe(false);
    expect(matches('@bob @anna', annas)).toBe(true);
    expect(matches('@anna', task('Plan', { assigneeId: null }))).toBe(false);
    expect(matches('@anna', task('Plan', { assigneeId: 'stranger' }))).toBe(false);
    expect(matchesTask(annas, parseSearchQuery('@anna'), withoutMembers)).toBe(false);
  });

  it('due: mirrors the smart views; is: filters by status', () => {
    const overdue = task('A', { dueDate: '2026-10-01' });
    const today = task('B', { dueDate: '2026-10-05' });
    const nextWeek = task('C', { dueDate: '2026-10-11' });
    const none = task('D');
    const done = task('E', { dueDate: '2026-10-05', completedAt: 1 });
    const all = [overdue, today, nextWeek, none, done];
    const titles = (q: string) =>
      all.filter((t) => matchesFilters(t, parseSearchQuery(q), ctx)).map((t) => t.title);
    expect(titles('due:today')).toEqual(['A', 'B', 'E']);
    expect(titles('due:overdue')).toEqual(['A']);
    expect(titles('due:week')).toEqual(['B', 'C', 'E']);
    expect(titles('due:none')).toEqual(['D']);
    expect(titles('is:open')).toEqual(['A', 'B', 'C', 'D']);
    expect(titles('is:done')).toEqual(['E']);
    expect(titles('due:today is:open')).toEqual(['A', 'B']);
    expect(titles('')).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('fuzzyScore', () => {
  it('returns null unless the query is a subsequence', () => {
    expect(fuzzyScore('xyz', 'New task')).toBeNull();
    expect(fuzzyScore('ksat', 'New task')).toBeNull();
    expect(fuzzyScore('a long query', 'abc')).toBeNull();
    expect(fuzzyScore('a', '')).toBeNull();
  });

  it('scores the empty query 0 for every label', () => {
    for (const label of ['', 'New task', 'Gå till Idag']) {
      expect(fuzzyScore('', label)).toBe(0);
      expect(fuzzyScore('   ', label)).toBe(0);
    }
  });

  it('ignores case, diacritics and query whitespace', () => {
    expect(fuzzyScore('ga till', 'Gå till Idag')).not.toBeNull();
    expect(fuzzyScore('GTI', 'gå till idag')).toBe(fuzzyScore('gti', 'Gå till Idag'));
    expect(fuzzyScore('new task', 'New task')).toBe(fuzzyScore('newtask', 'New task'));
  });

  const rank = (query: string, labels: string[]) =>
    labels
      .map((label) => ({ label, score: fuzzyScore(query, label) }))
      .filter((r): r is { label: string; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.label);

  it.each<[string, string[], string[]]>([
    // Word starts beat letters inside a word.
    ['nt', ['Print', 'New task'], ['New task', 'Print']],
    // Consecutive runs beat scattered letters.
    ['set', ['Show completed tasks', 'Settings'], ['Settings', 'Show completed tasks']],
    // Shorter labels win ties.
    ['set', ['Set due date', 'Settings'], ['Settings', 'Set due date']],
    // camelCase boundaries count as word starts.
    ['gt', ['gotoToday', 'getting'], ['gotoToday', 'getting']],
    ['today', ['Go to Today', 'Toggle day view'], ['Go to Today', 'Toggle day view']],
  ])('%j ranks %j as %j', (query, labels, expected) => {
    expect(rank(query, labels)).toEqual(expected);
  });

  it('finds the best alignment, not the first one', () => {
    // A greedy match takes the "a" of "path" and loses the word-start bonus of "Add".
    const best = fuzzyScore('ad', 'path Add');
    const greedyOnly = fuzzyScore('ad', 'pathxxad');
    expect(best).not.toBeNull();
    expect(best as number).toBeGreaterThan(greedyOnly as number);
  });

  it('handles characters that fold to several letters', () => {
    expect(fuzzyScore('i', 'İstanbul')).not.toBeNull();
  });
});

describe('folding helpers', () => {
  it('fold case and diacritics and split words like unicode61', () => {
    expect(foldText('Tandläkare ÅÄÖ é')).toBe('tandlakare aao e');
    expect(searchWords('Svara på e-post, idag!')).toEqual(['svara', 'pa', 'e', 'post', 'idag']);
    expect(searchWords('  ')).toEqual([]);
  });
});
