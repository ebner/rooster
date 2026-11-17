import { groupActivity } from '@rooster/core/activity';
import type { Group, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import type { Me, QueryResult } from '../../data/types';
import { useSyncStore } from '../../state/sync-store';
import { ActivityFeed } from '../collab/activity-feed';
import { fixtureMovedAway, fixtureOrgMoved, fixturePeople } from '../collab/fixtures';
import { NotificationItem } from '../collab/notification-item';
import { sampleDateContext } from '../dates/fixtures';
import { DetailPane } from '../pane/detail-pane';
import { createPaneControls, focusListCursor } from '../pane/tasks-screen';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import {
  MoveOrgPanel,
  MoveOrgSheetBody,
  type MoveOrgTarget,
  type MoveOrgViewProps,
  useMoveOrgFlow,
} from './move-org-picker';
import { followedTo, movesWith, noteFollowed, paneOrgRedirect } from './store';

// The data layer's two queries, driven by each test.
const data = vi.hoisted(() => ({
  preview: { data: undefined, isPending: true, error: null } as QueryResult<unknown>,
  groups: { data: undefined, isPending: true, error: null } as QueryResult<unknown>,
  previewArgs: [] as [readonly string[], string | null][],
}));
vi.mock('../../data/move-to-org', () => ({
  useMoveToOrgPreview: (ids: readonly string[], orgId: string | null) => {
    data.previewArgs.push([ids, orgId]);
    return orgId ? data.preview : { data: undefined, isPending: true, error: null };
  },
  useMoveTargetGroups: (orgId: string | null) =>
    orgId ? data.groups : { data: undefined, isPending: true, error: null },
}));

const northwind = fixtureMe.orgs[1] as Me['orgs'][number];
const groups: Group[] = [
  ['01930000-0000-7000-8000-0000000000b1', 'inbox', 'Inbox'],
  ['01930000-0000-7000-8000-0000000000b2', 'normal', 'This week'],
  ['01930000-0000-7000-8000-0000000000b3', 'normal', 'Someday'],
].map(([id, kind, name], i) => ({
  id: id as string,
  orgId: northwind.id,
  kind: kind as Group['kind'],
  name: name as string,
  position: `a${i}`,
  collapsed: false,
}));
const quiet: TaskMoveToOrgPreview = {
  tasks: 1,
  subtasks: 0,
  comments: 0,
  attachments: 0,
  exposes: false,
  newTags: [],
  reassigned: 0,
};
const exposing: TaskMoveToOrgPreview = { ...quiet, comments: 3, attachments: 2, exposes: true };

function Flow({ onMove, sheet = false }: { onMove: (t: MoveOrgTarget) => void; sheet?: boolean }) {
  const flow = useMoveOrgFlow(['task-1'], onMove);
  const props = { orgs: fixtureMe.orgs, currentOrgId: fixtureIds.personalOrg, ...flow };
  return sheet ? <MoveOrgSheetBody {...props} /> : <MoveOrgPanel {...props} />;
}

const combobox = () => screen.getByRole('combobox');
const key = (k: string) => fireEvent.keyDown(combobox(), { key: k });

beforeEach(() => {
  data.preview = { data: quiet, isPending: false, error: null };
  data.groups = { data: groups, isPending: false, error: null };
  data.previewArgs = [];
  useSyncStore.setState({ online: true });
});

describe('ADR 0072 §22: the move-to-organisation picker', () => {
  test('step 1 lists the orgs; the current one is checked and not selectable', () => {
    render(<Flow onMove={vi.fn()} />);
    const list = screen.getByRole('listbox', { name: 'Organisations' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Personal'),
      expect.stringContaining('Northwind'),
      expect.stringContaining('Book club'),
    ]);
    expect(options[0]?.getAttribute('aria-disabled')).toBe('true');
    expect(within(options[0] as HTMLElement).getByLabelText('Current organisation')).toBeTruthy();
    // The first selectable org is active.
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    // Its digit does nothing; Enter picks the active org.
    key('1');
    expect(screen.getByTestId('move-org-orgs')).toBeTruthy();
  });

  test('Enter, Enter: the org, then its first normal group (the default)', () => {
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    key('Enter');
    expect(screen.getByRole('listbox', { name: 'Groups in Northwind' })).toBeTruthy();
    const active = screen.getAllByRole('option').find((o) => o.ariaSelected === 'true');
    expect(active?.textContent).toContain('This week');
    expect(data.previewArgs.at(-1)).toEqual([['task-1'], northwind.id]);
    key('Enter');
    expect(onMove).toHaveBeenCalledWith({
      orgId: northwind.id,
      orgName: 'Northwind',
      orgSlug: 'northwind',
      groupId: groups[1]?.id,
    });
  });

  test('digits pick in both steps; Backspace in the empty filter goes back', () => {
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    key('3');
    expect(screen.getByRole('listbox', { name: 'Groups in Book club' })).toBeTruthy();
    key('Backspace');
    expect(screen.getByRole('listbox', { name: 'Organisations' })).toBeTruthy();
    key('2');
    key('1');
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ groupId: groups[0]?.id }));
  });

  test('the filter narrows the groups; a click picks one', () => {
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    key('2');
    fireEvent.change(combobox(), { target: { value: 'some' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    fireEvent.click(options[0] as HTMLElement);
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ groupId: groups[2]?.id }));
  });

  test('§13: when other people’s content would be exposed, a third step confirms', () => {
    data.preview = { data: exposing, isPending: false, error: null };
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    key('2');
    key('Enter');
    expect(onMove).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('move-org-confirm');
    expect(confirm.textContent).toContain(
      '3 comments and 2 files by other people will be visible to members of Northwind.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('listbox', { name: 'Groups in Northwind' })).toBeTruthy();
    key('Enter');
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ groupId: groups[1]?.id }));
  });

  test('a pick made while the preview loads waits for it, then moves', () => {
    data.preview = { data: undefined, isPending: true, error: null };
    const onMove = vi.fn();
    const { rerender } = render(<Flow onMove={onMove} />);
    key('2');
    key('Enter');
    expect(screen.getByTestId('move-org-status').dataset.status).toBe('checking');
    expect(onMove).not.toHaveBeenCalled();
    data.preview = { data: quiet, isPending: false, error: null };
    rerender(<Flow onMove={onMove} />);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  test('§21: offline, the picker says it needs a connection and picks nothing', () => {
    useSyncStore.setState({ online: false });
    data.preview = { data: undefined, isPending: false, error: new Error('offline') };
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Moving to another organisation needs a connection.',
    );
    key('Enter');
    expect(screen.getByTestId('move-org-orgs')).toBeTruthy();
  });

  test('a failed preview blocks the group step', () => {
    data.preview = { data: undefined, isPending: false, error: new Error('boom') };
    const onMove = vi.fn();
    render(<Flow onMove={onMove} />);
    key('2');
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t check the move. Try again.');
    key('Enter');
    expect(onMove).not.toHaveBeenCalled();
  });

  test('the phone sheet: rows for orgs (current disabled), back, groups', () => {
    const onMove = vi.fn();
    render(<Flow onMove={onMove} sheet />);
    const personal = screen.getByRole('button', { name: /Personal/ });
    expect(personal.hasAttribute('disabled') || personal.dataset.disabled !== undefined).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Northwind/ }));
    expect(screen.getByText('Groups in Northwind')).toBeTruthy();
    fireEvent.click(screen.getByTestId('move-org-back'));
    fireEvent.click(screen.getByRole('button', { name: /Northwind/ }));
    fireEvent.click(screen.getByRole('button', { name: /Someday/ }));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ groupId: groups[2]?.id }));
  });

  test('the views render each step from props (kitchen sink)', () => {
    const base: MoveOrgViewProps = {
      orgs: fixtureMe.orgs,
      currentOrgId: fixtureIds.personalOrg,
      step: { kind: 'confirm', org: northwind, groupId: groups[1]?.id ?? '' },
      groups,
      preview: { ...exposing, attachments: 0, comments: 1 },
      status: 'ready',
      onPickOrg: vi.fn(),
      onPickGroup: vi.fn(),
      onBack: vi.fn(),
      onConfirm: vi.fn(),
      autoFocus: false,
    };
    render(<MoveOrgSheetBody {...base} />);
    expect(screen.getByTestId('move-org-confirm').textContent).toContain(
      '1 comment by other people will be visible to members of Northwind.',
    );
  });
});

describe('ADR 0072 §22/§23: the pane follows its task', () => {
  const now = 1_800_000_000_000;

  test('paneOrgRedirect: another org than the URL’s sends the pane there', () => {
    const orgs = fixtureMe.orgs;
    const base = { taskId: 't1', urlOrgId: fixtureIds.personalOrg, orgs, now };
    expect(paneOrgRedirect({ ...base, taskOrgId: fixtureIds.companyOrg })).toBe('northwind');
    expect(paneOrgRedirect({ ...base, taskOrgId: fixtureIds.personalOrg })).toBeNull();
    expect(paneOrgRedirect({ ...base, taskOrgId: undefined })).toBeNull();
    // An org the user isn't in: nowhere to go (the pane says it can't find the task).
    expect(paneOrgRedirect({ ...base, taskOrgId: 'elsewhere' })).toBeNull();
    // To the personal org: its alias.
    expect(
      paneOrgRedirect({
        ...base,
        urlOrgId: fixtureIds.companyOrg,
        taskOrgId: fixtureIds.personalOrg,
      }),
    ).toBe('personal');
  });

  test('a pane that just followed a move trusts it until the detail catches up', () => {
    noteFollowed('t2', fixtureIds.companyOrg, now);
    expect(followedTo('t2', now + 1000)).toBe(fixtureIds.companyOrg);
    const stale = {
      taskId: 't2',
      urlOrgId: fixtureIds.companyOrg,
      taskOrgId: fixtureIds.personalOrg,
      orgs: fixtureMe.orgs,
    };
    expect(paneOrgRedirect({ ...stale, now: now + 1000 })).toBeNull();
    expect(paneOrgRedirect({ ...stale, now: now + 120_000 })).toBe('personal');
  });

  test('movesWith: the task itself or one of its ancestors moves', () => {
    const state = {
      tasks: {
        a: { id: 'a', parentId: null },
        b: { id: 'b', parentId: 'a' },
        c: { id: 'c', parentId: null },
      },
    } as unknown as Parameters<typeof movesWith>[0];
    expect(movesWith(state, 'b', ['a'])).toBe(true);
    expect(movesWith(state, 'a', ['a'])).toBe(true);
    expect(movesWith(state, 'c', ['a'])).toBe(false);
    expect(movesWith(state, null, ['a'])).toBe(false);
  });

  test('followToOrg replaces the URL with the task under its new org', () => {
    const go = vi.fn();
    const pane = createPaneControls({
      current: () => 'task-9',
      setCurrent: () => undefined,
      go,
      orgSlug: 'personal',
      focusList: () => undefined,
    });
    pane.followToOrg('northwind');
    expect(go).toHaveBeenCalledWith('/o/northwind/t/task-9', true);
    go.mockClear();
    pane.followToOrg('personal');
    expect(go).not.toHaveBeenCalled();
  });

  test('§23: a pane opened under the wrong org (an old link) moves to the task’s org', async () => {
    const homeOrg = '01900000-0000-7000-8000-0000000000aa';
    const otherOrg = '01900000-0000-7000-8000-0000000000bb';
    const transport = createFixtureTransport({
      userId: fixtureMe.user.id,
      tasks: { 1: ['Alpha'] },
    });
    const taskId = Object.values(transport.state(homeOrg).tasks)[0]?.id as string;
    // The other org's list exists but doesn't hold the task.
    transport.state(otherOrg);
    const me: Me = {
      ...fixtureMe,
      orgs: [
        { ...(fixtureMe.orgs[1] as Me['orgs'][number]), id: homeOrg, slug: 'acme', name: 'Acme' },
        { ...(fixtureMe.orgs[2] as Me['orgs'][number]), id: otherOrg, slug: 'other' },
      ],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.me, me);
    queryClient.setQueryData(queryKeys.orgMembers(otherOrg), []);
    const navs: [string, boolean][] = [];
    function Harness() {
      const ref = useRef<string | null>(taskId);
      const pane = useMemo(
        () =>
          createPaneControls({
            current: () => ref.current,
            setCurrent: (id) => {
              ref.current = id;
            },
            go: (href, replace) => navs.push([href, replace]),
            orgSlug: 'other',
            focusList: focusListCursor,
          }),
        [],
      );
      return (
        <DetailPane
          orgId={otherOrg}
          orgSlug="other"
          userId={me.user.id}
          taskId={taskId}
          pane={pane}
          fullScreen={false}
          onFocusList={focusListCursor}
        />
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <ListTransportContext.Provider value={transport}>
          <Harness />
        </ListTransportContext.Provider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(navs).toContainEqual([`/o/acme/t/${taskId}`, true]));
  });
});

describe('ADR 0072 §22: the pane’s ⋯ menu', () => {
  test('Move to organisation… moves the task, toasts and the pane follows it', async () => {
    const homeOrg = '01900000-0000-7000-8000-0000000000aa';
    const transport = createFixtureTransport({
      userId: fixtureMe.user.id,
      tasks: { 1: ['Alpha'] },
    });
    const taskId = Object.values(transport.state(homeOrg).tasks)[0]?.id as string;
    const sent: string[] = [];
    const send = transport.send;
    transport.send = (op, org) => {
      sent.push(op.kind);
      return send(op, org);
    };
    const me: Me = {
      ...fixtureMe,
      orgs: [
        { ...(fixtureMe.orgs[0] as Me['orgs'][number]), id: homeOrg },
        ...fixtureMe.orgs.slice(1),
      ],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.me, me);
    queryClient.setQueryData(queryKeys.orgMembers(homeOrg), []);
    const navs: [string, boolean][] = [];
    function Harness() {
      const ref = useRef<string | null>(taskId);
      const pane = useMemo(
        () =>
          createPaneControls({
            current: () => ref.current,
            setCurrent: (id) => {
              ref.current = id;
            },
            go: (href, replace) => navs.push([href, replace]),
            orgSlug: 'personal',
            focusList: focusListCursor,
          }),
        [],
      );
      return (
        <DetailPane
          orgId={homeOrg}
          orgSlug="personal"
          userId={me.user.id}
          taskId={taskId}
          pane={pane}
          fullScreen={false}
          onFocusList={focusListCursor}
        />
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <ListTransportContext.Provider value={transport}>
          <Harness />
        </ListTransportContext.Provider>
      </QueryClientProvider>,
    );
    await screen.findByRole('toolbar', { name: 'Task actions' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to organisation…' }));
    await screen.findByRole('listbox', { name: 'Organisations' });
    key('2');
    key('Enter');
    await waitFor(() => expect(navs).toContainEqual([`/o/northwind/t/${taskId}`, true]));
    await waitFor(() => expect(sent).toContain('task.moveToOrg'));
    expect(followedTo(taskId)).toBe(fixtureIds.companyOrg);
  });
});

describe('ADR 0072 §15/§16: inbox and activity', () => {
  const dateCtx = sampleDateContext('en');

  test('moved_away names the task, not the org, and shows no task line', () => {
    const notification = fixtureMovedAway(dateCtx.nowMs);
    render(
      <NotificationItem
        notification={notification}
        orgName="Brightwater"
        now={dateCtx.nowMs}
        locale="en"
        dateCtx={dateCtx}
        onOpen={vi.fn()}
        onToggleRead={vi.fn()}
      />,
    );
    const item = screen.getByTestId('notification');
    expect(item.textContent).toContain(
      'Anna Lindqvist moved “Call the bank” to another organisation',
    );
    // The title appears once: in the sentence, not as an openable task line.
    expect(item.textContent?.split('Call the bank')).toHaveLength(2);
  });

  test('org_moved names the source org only to its members', () => {
    const entries = groupActivity(fixtureOrgMoved(dateCtx.nowMs));
    render(
      <ActivityFeed
        entries={entries}
        viewerId={fixtureIds.jannik}
        person={(id) => fixturePeople[id]}
        pending={new Set()}
        orgName={(id) => fixtureMe.orgs.find((o) => o.id === id)?.name}
        now={dateCtx.nowMs}
        locale="en"
        dateCtx={dateCtx}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const lines = screen.getAllByTestId('activity-line').map((l) => l.textContent);
    expect(lines[0]).toContain('Anna Lindqvist moved this task here from Personal');
    expect(lines[1]).toContain('Markus Lindén moved this task here from another organisation');
  });
});
