import { normalizeMyList } from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/output/color.ts';
import type { DateContext } from '../src/output/format.ts';
import { NO_GLOBALS, Runtime } from '../src/runtime.ts';
import { tuiTranslator } from '../src/tui/i18n.ts';
import { canRunTui, runTui, type TuiStreams } from '../src/tui/index.ts';
import { editLine, lineInput } from '../src/tui/input.ts';
import { commandFor, GO_KEYS, KEYMAP, type KeyInfo } from '../src/tui/keymap.ts';
import {
  buildLines,
  createTarget,
  keepSelection,
  type LinesInput,
  planMove,
  restorePlan,
  stepSelection,
  UPCOMING_KEY,
  upcomingIn,
} from '../src/tui/model.ts';
import { helpLines } from '../src/tui/render.ts';
import {
  BACKOFF_MS,
  SseClient,
  type SseMessage,
  SseParser,
  type SseState,
} from '../src/tui/sse.ts';
import { ellipsize, fit, seg, wrapAnsi } from '../src/tui/text.ts';
import { fakeIo } from './support/fake-io.ts';

const NO_KEY: KeyInfo = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};
const key = (patch: Partial<KeyInfo>): KeyInfo => ({ ...NO_KEY, ...patch });

describe('tui text', () => {
  it('fits segments to an exact width, cutting with an ellipsis', () => {
    expect(fit([seg('abc'), seg('def')], 8, 0)).toBe('abcdef  ');
    expect(fit([seg('abc'), seg('defgh')], 6, 0)).toBe('abcde…');
    expect(fit([seg('日本語のタスク')], 7, 0)).toBe('日本語…');
    expect(ellipsize('hello world', 6)).toBe('hello…');
    // Painted output keeps the width.
    const painted = fit([seg('abcdef', { bold: true })], 4, 3);
    expect(stripAnsi(painted)).toBe('abc…');
  });

  it('wraps painted text by words and reopens styles on the next line', () => {
    expect(wrapAnsi('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    const styled = `\u001b[1mbold words here\u001b[0m end`;
    const lines = wrapAnsi(styled, 10);
    expect(lines.map(stripAnsi)).toEqual(['bold words', 'here end']);
    expect(lines[0]?.endsWith('\u001b[0m')).toBe(true);
    expect(lines[1]?.startsWith('\u001b[1m')).toBe(true);
    expect(wrapAnsi('abcdefghij', 4).map(stripAnsi)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapAnsi('  • indented item text', 12).map(stripAnsi)).toEqual([
      '  • indented',
      '  item text',
    ]);
  });
});

describe('tui line input', () => {
  it('edits like a shell prompt', () => {
    let input = lineInput('abc');
    const apply = (text: string, k: Partial<KeyInfo> = {}) => {
      const result = editLine(input, text, key(k));
      if (result.kind === 'change') input = result.input;
      return result.kind;
    };
    expect(apply('', { leftArrow: true })).toBe('change');
    apply('X');
    expect(input).toEqual({ value: 'abXc', cursor: 3 });
    apply('', { backspace: true });
    apply('', { delete: true });
    expect(input.value).toBe('ab');
    apply('a', { ctrl: true });
    apply('pasted\ntext\u001b[31m');
    expect(input.value).toBe('pasted text[31mab');
    apply('w', { ctrl: true });
    expect(input.value).toBe('pasted ab');
    apply('u', { ctrl: true });
    expect(input).toEqual({ value: 'ab', cursor: 0 });
    expect(apply('', { return: true })).toBe('submit');
    expect(apply('', { escape: true })).toBe('cancel');
    expect(apply('', { upArrow: true })).toBe('ignored');
  });
});

describe('tui keymap', () => {
  it('has one binding per command and dispatches 07 §5 keys', () => {
    const ids = KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(commandFor('j', NO_KEY)).toBe('down');
    expect(commandFor('', key({ downArrow: true }))).toBe('down');
    expect(commandFor('x', NO_KEY)).toBe('complete');
    expect(commandFor('J', key({ shift: true }))).toBe('moveDown');
    expect(commandFor(']', NO_KEY)).toBe('nextGroup');
    expect(commandFor('r', key({ ctrl: true }))).toBe('redo');
    expect(commandFor('r', NO_KEY)).toBe('retry');
    expect(commandFor('c', key({ ctrl: true }))).toBe('quit');
    expect(commandFor('5', NO_KEY)).toBe('org');
    expect(commandFor('0', NO_KEY)).toBeNull();
    expect(Object.keys(GO_KEYS)).toEqual(['m', 't', 'w', 'o', 'n', 'e']);
  });

  it('generates the help from the keymap in both languages, differences included', () => {
    for (const locale of ['en', 'sv'] as const) {
      const lines = helpLines(tuiTranslator(locale));
      const text = lines.map((l) => `${l.keys} ${l.text}`).join('\n');
      for (const binding of KEYMAP) {
        if (binding.id !== 'go') expect(text).toContain(binding.keys);
      }
      // Every text resolved (no raw keys left).
      expect(text).not.toMatch(/\b(key|web|help)\.[a-zA-Z]+/);
    }
    const en = helpLines(tuiTranslator('en')).map((l) => l.text);
    expect(en).toContain('On the web: Ctrl+Enter (x selects rows there)');
    expect(en).toContain('Go to Everyone’s tasks');
  });
});

describe('tui SSE', () => {
  it('parses event streams across chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.push('event: hello\nid: 1\nda')).toEqual([]);
    expect(parser.push('ta: {"a":1}\n\n: ping\n\n')).toEqual([
      { event: 'hello', data: '{"a":1}', id: '1' },
    ]);
    expect(parser.push('data: x\r\ndata: y\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'x\ny', id: '1' }]);
  });

  it('reconnects with backoff, reports its state and stops on a refused login', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const states: SseState[] = [];
    const messages: SseMessage[] = [];
    const responses: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError('down')),
      () => Promise.reject(new TypeError('down')),
      () => new Response('event: hello\ndata: {}\n\n', { status: 200 }),
      () => new Response(null, { status: 401 }),
    ];
    let denied = 0;
    const client = new SseClient({
      url: 'https://rooster.test/api/v1/events',
      headers: async () => ({ Authorization: 'Bearer t' }),
      fetch: async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error('no more');
        return next();
      },
      onMessage: (m) => messages.push(m),
      onState: (s) => states.push(s),
      onDenied: () => denied++,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
    const runRetry = async () => {
      const retry = timers.filter((t) => t.ms !== 55_000).pop();
      timers.length = 0;
      retry?.fn();
      await flush();
    };
    client.start();
    await flush();
    expect(states).toEqual(['connecting', 'offline']);
    expect(timers.at(-1)?.ms).toBe(BACKOFF_MS[0]);
    await runRetry();
    expect(timers.at(-1)?.ms).toBe(BACKOFF_MS[1]);
    await runRetry();
    expect(messages).toEqual([{ event: 'hello', data: '{}', id: null }]);
    expect(states).toContain('open');
    // The stream ended (server restart): reconnect after the first step, then refused.
    await runRetry();
    expect(denied).toBe(1);
    expect(states.at(-1)).toBe('offline');
    client.stop();
  });
});

const GROUPS: Group[] = [
  { id: 'g-inbox', orgId: 'o', kind: 'inbox', name: 'Inbox', position: 'a0', collapsed: false },
  { id: 'g-a', orgId: 'o', kind: 'normal', name: 'A', position: 'a1', collapsed: false },
  { id: 'g-b', orgId: 'o', kind: 'normal', name: 'B', position: 'a2', collapsed: false },
];

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    orgId: 'o',
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id,
    hasDescription: false,
    assigneeId: 'me',
    createdBy: 'me',
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task;
}

const placed = (id: string, groupId: string, position: string, patch: Partial<Task> = {}) =>
  task(id, { placement: { groupId, position }, ...patch });

const LIST = normalizeMyList('o', {
  groups: GROUPS,
  tasks: [
    placed('a1', 'g-a', 'a0', {
      counts: { subtasks: 2, subtasksDone: 1, comments: 0, attachments: 0 },
    }),
    placed('a2', 'g-a', 'a1', { completedAt: 5 }),
    placed('a3', 'g-a', 'a2'),
    task('s1', { parentId: 'a1', subtaskPosition: 'a0' }),
    task('s2', { parentId: 'a1', subtaskPosition: 'a1', completedAt: 1 }),
    placed('b1', 'g-b', 'a0', { dueDate: '2026-10-09' }),
  ],
  expandedTaskIds: ['a1'],
  serverTime: 0,
});

const DATES: DateContext = {
  today: '2026-10-09',
  nowMs: Date.UTC(2026, 9, 9, 12),
  timezone: 'UTC',
  locale: 'en',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};

const input = (patch: Partial<LinesInput> = {}): LinesInput => ({
  view: 'my',
  list: LIST,
  viewerId: 'me',
  dates: DATES,
  showCompleted: false,
  keep: new Set(),
  expanded: new Set(LIST.expandedTaskIds),
  collapsed: (g) => g.collapsed,
  members: null,
  everyone: null,
  search: null,
  t: tuiTranslator('en'),
  ...patch,
});

const visibleOpen = (t: Task) => t.completedAt === null;

describe('tui model', () => {
  it('builds My tasks: the empty Inbox hidden, open rows, expanded subtasks', () => {
    const lines = buildLines(input());
    expect(
      lines.map((l) => (l.kind === 'task' ? `${'  '.repeat(l.depth)}${l.key}` : l.key)),
    ).toEqual(['group:g-a', 'a1', '  s1', 'a3', 'group:g-b', 'b1']);
    const collapsed = buildLines(input({ collapsed: (g) => g.id === 'g-a' }));
    expect(collapsed.map((l) => l.key)).toEqual(['group:g-a', 'group:g-b', 'b1']);
    const withDone = buildLines(input({ showCompleted: true }));
    expect(withDone.filter((l) => l.kind === 'task').map((l) => l.key)).toEqual([
      'a1',
      's1',
      's2',
      'a2',
      'a3',
      'b1',
    ]);
  });

  it('builds the smart views with the shared selectors', () => {
    const today = buildLines(input({ view: 'today' }));
    expect(today.map((l) => l.key)).toEqual(['section:today', 'b1']);
    expect(today[0]?.kind === 'section' && today[0].title).toBe('Friday, Oct 9');
    const chip = today[1]?.kind === 'task' ? today[1].chip : null;
    expect(chip).toBe('B');
    const nodate = buildLines(input({ view: 'nodate' }));
    expect(nodate.map((l) => l.key)).toEqual(['a1', 's1', 'a3']);
    const overdue = buildLines(input({ view: 'overdue' }));
    expect(overdue).toEqual([{ kind: 'empty', key: 'empty', text: 'Nothing overdue' }]);
  });

  it('keeps the selection by task, or the row now where it was', () => {
    const lines = buildLines(input());
    expect(stepSelection(lines, 'a1', 1)).toBe('s1');
    expect(stepSelection(lines, 'b1', 5)).toBe('b1');
    expect(stepSelection(lines, 'gone', 1)).toBe('group:g-a');
    expect(keepSelection(lines, 'a3', 0)).toBe('a3');
    expect(keepSelection(lines, 'gone', 3)).toBe('a3');
    expect(keepSelection(lines, 'gone', 99)).toBe('b1');
  });

  it('plans moves as intents, crossing groups at the edges', () => {
    expect(planMove(LIST, 'a1', 'down', visibleOpen)).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', afterId: 'a3' },
    });
    expect(planMove(LIST, 'a3', 'up', visibleOpen)).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', beforeId: 'a1' },
    });
    expect(planMove(LIST, 'a3', 'down', visibleOpen)).toEqual({
      kind: 'move',
      body: { groupId: 'g-b', afterId: null, beforeId: 'b1' },
    });
    expect(planMove(LIST, 'b1', 'up', visibleOpen)).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', afterId: 'a3' },
    });
    expect(planMove(LIST, 'a1', 'up', visibleOpen)).toBeNull();
    expect(planMove(LIST, 'b1', 'down', visibleOpen)).toBeNull();
    expect(planMove(LIST, 'a1', 'nextGroup', visibleOpen)).toEqual({
      kind: 'move',
      body: { groupId: 'g-b', afterId: null, beforeId: 'b1' },
    });
    expect(planMove(LIST, 's1', 'down', () => true)).toEqual({
      kind: 'reorder',
      body: { afterId: 's2' },
    });
    expect(planMove(LIST, 's1', 'nextGroup', () => true)).toBeNull();
  });

  it('plans the way back from the full order (completed rows included)', () => {
    expect(restorePlan(LIST, 'a3')).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', afterId: 'a2' },
    });
    expect(restorePlan(LIST, 'a1')).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', afterId: null, beforeId: 'a2' },
    });
    expect(restorePlan(LIST, 'b1')).toEqual({ kind: 'move', body: { groupId: 'g-b' } });
    expect(restorePlan(LIST, 's2')).toEqual({ kind: 'reorder', body: { afterId: 's1' } });
  });

  it('targets new tasks like the web: below or above, at the top of a group, as subtasks', () => {
    const lines = buildLines(input());
    // Below a1 goes after its shown subtasks, as a sibling of a1.
    expect(createTarget('my', lines, LIST, 'a1', 'below')).toMatchObject({
      anchorKey: 's1',
      placement: 'after',
      depth: 0,
      body: { groupId: 'g-a', afterId: 'a1' },
    });
    expect(createTarget('my', lines, LIST, 'a3', 'above')).toMatchObject({
      anchorKey: 'a3',
      placement: 'before',
      body: { groupId: 'g-a', afterId: null, beforeId: 'a3' },
    });
    expect(createTarget('my', lines, LIST, 'group:g-b', 'below')).toMatchObject({
      body: { groupId: 'g-b', afterId: null, beforeId: 'b1' },
    });
    expect(createTarget('my', lines, LIST, 's1', 'below')).toMatchObject({
      depth: 1,
      body: { parentId: 'a1', afterId: 's1' },
    });
    expect(createTarget('my', lines, LIST, 'a1', 'subtask')).toMatchObject({
      anchorKey: 's1',
      depth: 1,
      body: { parentId: 'a1' },
      expandTask: 'a1',
    });
    const week = buildLines(input({ view: 'week' }));
    expect(createTarget('week', week, LIST, 'section:2026-10-11', 'below')).toMatchObject({
      body: { dueDate: '2026-10-11' },
    });
    expect(createTarget('search', lines, LIST, 'a1', 'below')).toBeNull();
  });
});

describe('ADR 0068: Upcoming in the TUI model', () => {
  // Today is 2026-10-09 (DATES). r1 repeats from tomorrow, r2 from a start date the day after,
  // r3 is due today (its day has come), once is a plain future task, sub a repeating subtask.
  const UP = normalizeMyList('o', {
    groups: GROUPS,
    tasks: [
      placed('a1', 'g-a', 'a0'),
      placed('r1', 'g-a', 'a1', { dueDate: '2026-10-10', recurrence: 'FREQ=DAILY' }),
      placed('a2', 'g-a', 'a2'),
      placed('r3', 'g-a', 'a3', { dueDate: '2026-10-09', recurrence: 'FREQ=DAILY' }),
      placed('once', 'g-b', 'a0', { dueDate: '2026-10-20' }),
      placed('r2', 'g-inbox', 'a0', {
        startDate: '2026-10-11',
        dueDate: '2026-10-11',
        recurrence: 'FREQ=WEEKLY',
        counts: { subtasks: 1, subtasksDone: 0, comments: 0, attachments: 0 },
      }),
      task('sub', {
        parentId: 'r2',
        subtaskPosition: 'a0',
        dueDate: '2026-10-12',
        recurrence: 'FREQ=DAILY',
      }),
      // A broken server value never holds a task back.
      placed('bad', 'g-b', 'a1', { dueDate: 'soon', recurrence: 'FREQ=DAILY' }),
    ],
    expandedTaskIds: ['r2'],
    serverTime: 0,
  });
  const shown = (lines: ReturnType<typeof buildLines>) =>
    lines.map((l) => (l.kind === 'task' ? `${'  '.repeat(l.depth)}${l.key}` : l.key));

  it('holds open repeating tasks out of their groups, behind a collapsed Upcoming at the end', () => {
    const lines = buildLines(input({ list: UP, expanded: new Set(UP.expandedTaskIds) }));
    // The Inbox only held r2, so it is hidden like an empty Inbox.
    expect(shown(lines)).toEqual([
      'group:g-a',
      'a1',
      'a2',
      'r3',
      'group:g-b',
      'once',
      'bad',
      UPCOMING_KEY,
    ]);
    expect(lines.find((l) => l.key === 'group:g-a')).toMatchObject({ count: 3 });
    expect(lines.at(-1)).toEqual({
      kind: 'upcoming',
      key: UPCOMING_KEY,
      count: 2,
      collapsed: true,
    });
  });

  it('opened, lists them by day with the group they go back to; subtasks stay under them', () => {
    const lines = buildLines(
      input({ list: UP, expanded: new Set(UP.expandedTaskIds), upcomingOpen: true }),
    );
    expect(shown(lines).slice(shown(lines).indexOf(UPCOMING_KEY))).toEqual([
      UPCOMING_KEY,
      'r1',
      'r2',
      '  sub',
    ]);
    const row = (key: string) => lines.find((l) => l.key === key);
    expect(row('r1')).toMatchObject({ section: UPCOMING_KEY, chip: 'A' });
    // The Inbox goes unnamed, as in the smart views.
    expect(row('r2')).toMatchObject({ section: UPCOMING_KEY, chip: null, expanded: true });
    expect(row('sub')).toMatchObject({ section: UPCOMING_KEY, depth: 1 });
  });

  it('on its day a task is back in its group at its own position', () => {
    const later = { ...DATES, today: '2026-10-11' };
    const lines = buildLines(input({ list: UP, dates: later, expanded: new Set() }));
    expect(shown(lines)).toEqual([
      'group:g-inbox',
      'r2',
      'group:g-a',
      'a1',
      'r1',
      'a2',
      'r3',
      'group:g-b',
      'once',
      'bad',
    ]);
  });

  it('a row completed in Upcoming stays there while held; completed ones elsewhere stay put', () => {
    const done = normalizeMyList('o', {
      groups: GROUPS,
      tasks: [
        placed('a1', 'g-a', 'a0'),
        placed('r1', 'g-a', 'a1', {
          dueDate: '2026-10-10',
          recurrence: 'FREQ=DAILY',
          completedAt: 5,
        }),
      ],
      expandedTaskIds: [],
      serverTime: 0,
    });
    const held = buildLines(input({ list: done, keep: new Set(['r1']), upcomingOpen: true }));
    expect(shown(held)).toEqual(['group:g-a', 'a1', 'group:g-b', UPCOMING_KEY, 'r1']);
    expect(held.at(-2)).toMatchObject({ count: 0 });
    // Shown with "show completed", a completed instance is in its group (it isn't upcoming).
    const all = buildLines(input({ list: done, showCompleted: true }));
    expect(shown(all)).toEqual(['group:g-a', 'a1', 'r1', 'group:g-b']);
    expect(upcomingIn({ dates: DATES, keep: new Set() })(done.tasks.r1 as Task)).toBe(false);
  });

  it('with only Upcoming tasks, the hint says so above it', () => {
    const only = normalizeMyList('o', {
      groups: [GROUPS[0] as Group],
      tasks: [placed('r1', 'g-inbox', 'a0', { dueDate: '2026-10-10', recurrence: 'FREQ=DAILY' })],
      expandedTaskIds: [],
      serverTime: 0,
    });
    const lines = buildLines(input({ list: only }));
    expect(lines.map((l) => l.kind)).toEqual(['empty', 'upcoming']);
    expect(lines[0]).toMatchObject({
      text: 'Nothing to do now; Recurring has what’s coming. Press n to add a task.',
    });
  });

  it('new tasks never go into Upcoming: n there adds at the top; s adds a subtask', () => {
    const lines = buildLines(
      input({ list: UP, expanded: new Set(UP.expandedTaskIds), upcomingOpen: true }),
    );
    const top = { anchorKey: null, placement: 'after', depth: 0, body: {} };
    expect(createTarget('my', lines, UP, UPCOMING_KEY, 'below')).toEqual(top);
    expect(createTarget('my', lines, UP, 'r1', 'below')).toEqual(top);
    expect(createTarget('my', lines, UP, 'r1', 'above')).toEqual(top);
    expect(createTarget('my', lines, UP, UPCOMING_KEY, 'subtask')).toBeNull();
    expect(createTarget('my', lines, UP, 'r1', 'subtask')).toMatchObject({
      body: { parentId: 'r1' },
    });
    // Below a subtask in Upcoming is its sibling, as anywhere else.
    expect(createTarget('my', lines, UP, 'sub', 'below')).toMatchObject({
      body: { parentId: 'r2', afterId: 'sub' },
    });
    // In a group, the rows Upcoming holds are stepped over by moves.
    const up = upcomingIn({ dates: DATES, keep: new Set() });
    const visible = (t: Task) => t.completedAt === null && !up(t);
    expect(planMove(UP, 'a2', 'up', visible)).toEqual({
      kind: 'move',
      body: { groupId: 'g-a', beforeId: 'a1' },
    });
  });
});

describe('tui entry', () => {
  it('runs only on a raw-mode terminal; otherwise the caller falls back to rooster ls', async () => {
    const tty = { isTTY: true, setRawMode: () => {} } as unknown as NodeJS.ReadStream;
    const out = { isTTY: true } as unknown as NodeJS.WriteStream;
    const streams = (stdin: NodeJS.ReadStream, stdout = out): TuiStreams => ({ stdin, stdout });
    const runtime = (env: Record<string, string> = {}, stdinIsTTY = true) => {
      const io = fakeIo('/nonexistent', { stdinIsTTY });
      io.env = { ...io.env, ...env };
      return new Runtime(io, NO_GLOBALS);
    };
    expect(canRunTui(runtime(), streams(tty))).toBe(true);
    expect(canRunTui(runtime({}, false), streams(tty))).toBe(false);
    expect(canRunTui(runtime(), streams({ isTTY: true } as unknown as NodeJS.ReadStream))).toBe(
      false,
    );
    expect(canRunTui(runtime(), streams(tty, { isTTY: false } as NodeJS.WriteStream))).toBe(false);
    expect(canRunTui(runtime({ TERM: 'dumb' }), streams(tty))).toBe(false);
    // No terminal: false at once, before anything is loaded or asked of the server.
    expect(await runTui(runtime({}, false), streams(tty))).toBe(false);
  });
});

describe('[P2] TUI timers', () => {
  it('guarded: a throwing timer callback reaches onError instead of the event loop', async () => {
    const { guarded } = await import('../src/tui/controller.ts');
    const errors: unknown[] = [];
    const boom = new RangeError('Invalid time zone specified: UTC\u001b]52;c;QUJD\u0007');
    expect(() =>
      guarded(
        () => {
          throw boom;
        },
        (error) => errors.push(error),
      )(),
    ).not.toThrow();
    expect(errors).toEqual([boom]);
    let ran = false;
    guarded(
      () => {
        ran = true;
      },
      () => errors.push('unexpected'),
    )();
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
