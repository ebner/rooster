import { emptyListState, type ListState } from '@rooster/core/reducers';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type Task } from '@rooster/core/schemas';
import { parseSearchQuery } from '@rooster/core/search';
import { describe, expect, test } from 'vitest';
import { paletteCommandIds, primaryKeys } from '../../keymap';
import { fixtureMe } from '../shell/fixtures';
import { type ActionContext, buildActions } from './actions';
import {
  type ActionItem,
  buildSections,
  highlightTerms,
  mixedActionsMax,
  nextActiveKey,
  rankActions,
  searchCachedTasks,
  splitSnippet,
  stepActiveKey,
  subtreeOf,
  type TaskItem,
} from './model';

const orgId = '0192f5d0-7a1e-7c3a-9f10-0000000000a1';
let n = 0;
function task(title: string, overrides: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: `0192f5d0-0000-7000-8000-${String(n).padStart(12, '0')}`,
    orgId,
    seq: n,
    parentId: null,
    subtaskPosition: null,
    title,
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
    createdAt: n,
    updatedAt: n,
    ...overrides,
  };
}

function listOf(tasks: Task[], id = orgId): ListState {
  return { ...emptyListState(id), tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}

const ctx = {
  today: '2026-10-08',
  nowMs: Date.UTC(2026, 9, 8, 8),
  viewerTz: 'Europe/Stockholm',
  viewerId: 'me',
  tagsById: {},
};

function actionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    orgs: fixtureMe.orgs,
    currentOrg: fixtureMe.orgs[0] ?? null,
    isAdmin: false,
    hasSelection: false,
    canMakeSubtask: false,
    phone: false,
    isAvailable: () => true,
    label: (id) => id,
    goToOrgLabel: (name) => `Go to ${name}`,
    ...overrides,
  };
}

const taskItem = (t: Task): TaskItem => ({
  kind: 'task',
  key: `tasks:${t.id}`,
  task: t,
  orgId,
  title: [{ text: t.title, mark: false }],
  snippet: null,
  chip: null,
});

describe('palette sections (02 §12)', () => {
  const actions = buildActions(actionContext({ hasSelection: true }));
  const recents = [taskItem(task('Recent one'))];

  test('empty query: recents, then actions with task actions first', () => {
    const sections = buildSections({
      query: '',
      parsed: parseSearchQuery(''),
      recents,
      tasks: [],
      actions,
    });
    expect(sections.map((s) => s.id)).toEqual(['recent', 'actions']);
    const first = sections[1]?.items[0] as ActionItem;
    expect(first.group).toBe('task');
  });

  test('search mode (/) shows no actions until the query asks with >', () => {
    const sections = buildSections({
      query: '',
      parsed: parseSearchQuery(''),
      recents,
      tasks: [],
      actions,
      searchMode: true,
    });
    expect(sections.map((s) => s.id)).toEqual(['recent']);
    const forced = buildSections({
      query: '>',
      parsed: parseSearchQuery('>'),
      recents,
      tasks: [],
      actions,
      searchMode: true,
    });
    expect(forced.map((s) => s.id)).toEqual(['actions']);
  });

  test('AC-5.3 ">move" lists the move action for the selection; ">dark" is empty', () => {
    const move = buildSections({
      query: '>move',
      parsed: parseSearchQuery('>move'),
      recents,
      tasks: [taskItem(task('Move house'))],
      actions,
    });
    expect(move.map((s) => s.id)).toEqual(['actions']);
    const labels = move[0]?.items.map((i) => (i as ActionItem).commandId);
    expect(labels).toContain('moveTo');
    expect(
      buildSections({
        query: '>dark',
        parsed: parseSearchQuery('>dark'),
        recents,
        tasks: [],
        actions,
      }),
    ).toEqual([]);
  });

  test('typed text: tasks first, then at most a few matching actions', () => {
    const tasks = [taskItem(task('Go jogging'))];
    const sections = buildSections({
      query: 'go',
      parsed: parseSearchQuery('go'),
      recents,
      tasks,
      actions,
    });
    expect(sections.map((s) => s.id)).toEqual(['tasks', 'actions']);
    expect(sections[1]?.items.length).toBeLessThanOrEqual(mixedActionsMax);
    // A filter-only query never matches actions.
    const filtered = buildSections({
      query: '#home',
      parsed: parseSearchQuery('#home'),
      recents,
      tasks,
      actions,
    });
    expect(filtered.map((s) => s.id)).toEqual(['tasks']);
  });

  test('ranking prefers word starts; ties keep registry order', () => {
    const ranked = rankActions(actions, 'gt');
    expect(ranked[0]?.commandId).toBe('goToday');
    expect(rankActions(actions, 'zzzz')).toEqual([]);
  });

  test('active item: kept while listed, ↑/↓ wrap across sections', () => {
    const sections = buildSections({
      query: '',
      parsed: parseSearchQuery(''),
      recents,
      tasks: [],
      actions,
    });
    const first = recents[0]?.key ?? '';
    expect(nextActiveKey(sections, null)).toBe(first);
    expect(nextActiveKey(sections, 'gone')).toBe(first);
    const second = stepActiveKey(sections, first, 1);
    expect(nextActiveKey(sections, second)).toBe(second);
    expect(stepActiveKey(sections, first, -1)).toBe(sections.at(-1)?.items.at(-1)?.key);
    expect(stepActiveKey([], null, 1)).toBeNull();
  });
});

describe('actions from the registry (04 §5.3)', () => {
  test('task actions need a selection; make subtask needs the list command', () => {
    const none = buildActions(actionContext());
    expect(none.some((a) => a.group === 'task')).toBe(false);
    const some = buildActions(actionContext({ hasSelection: true }));
    expect(some.some((a) => a.commandId === 'moveTo')).toBe(true);
    expect(some.some((a) => a.commandId === 'makeSubtaskOf')).toBe(false);
    const all = buildActions(actionContext({ hasSelection: true, canMakeSubtask: true }));
    expect(all.find((a) => a.commandId === 'makeSubtaskOf')?.shortcut).toBeNull();
  });

  test('each action shows its registry binding; one Go to per org with Mod+N', () => {
    const actions = buildActions(actionContext({ isAdmin: true }));
    const today = actions.find((a) => a.commandId === 'goToday');
    expect(today?.shortcut).toBe(primaryKeys('goToday'));
    const orgs = actions.filter((a) => a.commandId === 'goToOrg');
    expect(orgs).toHaveLength(fixtureMe.orgs.length);
    expect(orgs[0]?.shortcut).toBe('Mod+1');
    expect(orgs[0]?.args).toEqual({ key: '1', code: 'Digit1' });
    expect(actions.some((a) => a.commandId === 'openAdmin')).toBe(true);
    expect(buildActions(actionContext()).some((a) => a.commandId === 'openAdmin')).toBe(false);
  });

  test('unavailable commands and the phone sidebar toggle are hidden', () => {
    const actions = buildActions(actionContext({ isAvailable: () => false, phone: true }));
    expect(actions.some((a) => a.commandId === 'toggleSidebar')).toBe(false);
    expect(actions.some((a) => a.commandId === 'toggleCompleted')).toBe(false);
    expect(actions.some((a) => a.commandId === 'openTrash')).toBe(true);
  });

  test('every palette command is registered with a group', () => {
    expect(paletteCommandIds).toContain('moveTo');
    expect(paletteCommandIds).toContain('openTrash');
    expect(paletteCommandIds).not.toContain('selectNext');
  });
});

describe('highlights', () => {
  test('server snippets split on the markers', () => {
    expect(splitSnippet(`Boka ${SNIPPET_MARK_START}tand${SNIPPET_MARK_END}läkare`)).toEqual([
      { text: 'Boka ', mark: false },
      { text: 'tand', mark: true },
      { text: 'läkare', mark: false },
    ]);
    expect(splitSnippet('plain')).toEqual([{ text: 'plain', mark: false }]);
  });

  test('offline titles mark word prefixes, ignoring case and diacritics', () => {
    expect(highlightTerms('Boka tandläkare', ['TAND'])).toEqual([
      { text: 'Boka ', mark: false },
      { text: 'tand', mark: true },
      { text: 'läkare', mark: false },
    ]);
    expect(highlightTerms('Läsa bok', ['las'])).toEqual([
      { text: 'Läs', mark: true },
      { text: 'a bok', mark: false },
    ]);
    expect(highlightTerms('No match', [])).toEqual([{ text: 'No match', mark: false }]);
  });
});

describe('offline search over the cache (FR-PWA-2)', () => {
  const dentist = task('Boka tandläkare');
  const done = task('Tandborste', { completedAt: 5 });
  const other = task('Tandkräm', {});
  const lists = [listOf([dentist, done]), listOf([{ ...other, orgId: 'org-2' }], 'org-2')];

  test('prefix terms match titles; open tasks first; scoped to one org or all', () => {
    const parsed = parseSearchQuery('tand');
    const mine = searchCachedTasks(lists, parsed, ctx, { orgId });
    expect(mine.map((t) => t.title)).toEqual(['Boka tandläkare', 'Tandborste']);
    const all = searchCachedTasks(lists, parsed, ctx, { orgId: null });
    expect(all).toHaveLength(3);
    expect(all.at(-1)?.title).toBe('Tandborste');
  });

  test('filters and exclusions apply', () => {
    expect(searchCachedTasks(lists, parseSearchQuery('tand is:done'), ctx, { orgId })).toEqual([
      done,
    ]);
    expect(
      searchCachedTasks(lists, parseSearchQuery('tand'), ctx, {
        orgId,
        exclude: new Set([dentist.id]),
      }),
    ).toEqual([done]);
  });

  test('a selection excludes its whole subtree', () => {
    const parent = task('Parent');
    const child = task('Child', { parentId: parent.id });
    const grandchild = task('Grandchild', { parentId: child.id });
    const list = listOf([parent, child, grandchild]);
    expect(subtreeOf(list, [parent.id])).toEqual(new Set([parent.id, child.id, grandchild.id]));
    expect(subtreeOf(undefined, ['x'])).toEqual(new Set(['x']));
  });
});
