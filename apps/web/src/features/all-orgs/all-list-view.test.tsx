import { addDays, todayIn } from '@rooster/core/dates';
import { inboxOf, type ListOp } from '@rooster/core/reducers';
import type { AllView } from '@rooster/core/views';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import type { Me } from '../../data/types';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import type { PaneControls } from '../pane/pane-controls';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { AllListView } from './all-list-view';
import { defaultOrgOf } from './default-org';

/** ADR 0073 A2–A4 (AC-13.1, AC-13.2 in the component): All organisations' rows and new rows. */

const userId = fixtureMe.user.id;
const personal = fixtureIds.personalOrg;
const north = fixtureIds.companyOrg;
const club = fixtureIds.clubOrg;
const today = todayIn(fixtureMe.user.timezone, Date.now());

function KeymapRoot() {
  useKeymap();
  return null;
}

const pane: PaneControls = {
  taskId: () => null,
  open: () => undefined,
  close: () => undefined,
  followToOrg: () => undefined,
  toggleFullScreen: () => undefined,
};

async function setup(view: AllView = 'today', me: Me = fixtureMe) {
  const transport = createFixtureTransport({
    userId,
    tasks: {
      0: [{ title: 'Due today', dueDate: today }],
      2: [{ title: 'Late', dueDate: addDays(today, -3) }, 'Someday'],
    },
  });
  const sent: { op: ListOp; org: string }[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push({ op, org });
    return send(op, org);
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(queryKeys.me, me);
  for (const org of [north, club]) queryClient.setQueryData(queryKeys.orgMembers(org), []);
  const ui = (m: Me) => (
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <AllListView
          orgs={m.orgs}
          userId={userId}
          defaultOrgId={defaultOrgOf(m)?.id ?? ''}
          view={view}
          label="All organisations"
          pane={pane}
        />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>
  );
  const result = render(ui(me));
  await screen.findByRole('treegrid');
  await waitFor(() => expect(screen.getAllByTestId('task-row')).toHaveLength(6));
  const taskIn = (org: string, title: string) =>
    Object.values(transport.state(org).tasks).find((t) => t.title === title);
  return { transport, sent, taskIn, rerender: (m: Me) => result.rerender(ui(m)) };
}

function activeInput(): HTMLInputElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) throw new Error('no input focused');
  return el;
}

function type(text: string) {
  const input = activeInput();
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  fireEvent.input(input);
}

/** An option's name (its avatar is decorative). */
const optionName = (option: HTMLElement) => option.lastElementChild?.textContent;

const rowOrgs = () =>
  screen
    .getAllByTestId('task-row')
    .map((row) => [
      row.querySelector('[data-focus-target]')?.textContent,
      within(row).queryByTestId('org-chip')?.dataset.orgId,
    ]);

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
});

afterEach(() => {
  clearToasts();
});

describe('All organisations (ADR 0073 A)', () => {
  test('Today mixes every org’s overdue and today tasks, each with its org chip', async () => {
    await setup();
    expect(rowOrgs()).toEqual([
      ['Late', personal],
      ['Late', north],
      ['Late', club],
      ['Due today', personal],
      ['Due today', north],
      ['Due today', club],
    ]);
    const row = screen.getAllByTestId('task-row')[1] as HTMLElement;
    expect(row.getAttribute('aria-label')).toContain('in Northwind');
    expect(within(row).getByTestId('org-chip').textContent).toContain('Northwind');
    // Sorted view: no drag handles; Overdue takes no adds.
    expect(screen.queryAllByRole('button', { name: /^Drag/ })).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Add task' })).toHaveLength(1);
  });

  test('completing a row queues the op under its own org', async () => {
    const { sent, taskIn } = await setup();
    const late = taskIn(north, 'Late');
    const row = screen.getAllByTestId('task-row')[1] as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toMatchObject({
      org: north,
      op: { kind: 'task.complete', entityId: late?.id },
    });
    await waitFor(() => expect(taskIn(north, 'Late')?.completedAt).not.toBeNull());
    expect(taskIn(personal, 'Late')?.completedAt).toBeNull();
  });

  test('AC-13.2 a new row shows the default org; `^Nor` completes to Northwind and goes there', async () => {
    const { taskIn, transport } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(screen.getByTestId('draft-org-chip').dataset.orgId).toBe(personal));
    type('Book the venue ^Nor');
    const suggest = await screen.findByTestId('org-suggest');
    expect(within(suggest).getAllByRole('option').map(optionName)).toEqual(['Northwind']);
    fireEvent.keyDown(activeInput(), { key: 'Enter' });
    expect(activeInput().value).toBe('Book the venue ^Northwind ');
    await waitFor(() => expect(screen.getByTestId('draft-org-chip').dataset.orgId).toBe(north));
    // The token is highlighted like the other title tokens.
    await waitFor(() =>
      expect(activeInput().parentElement?.querySelector('mark')?.textContent).toBe('^Northwind'),
    );
    fireEvent.keyDown(activeInput(), { key: 'Enter' });
    await waitFor(() => expect(taskIn(north, 'Book the venue')).toBeDefined());
    const venue = taskIn(north, 'Book the venue');
    expect(venue?.dueDate).toBe(today);
    expect(venue?.placement?.groupId).toBe(inboxOf(transport.state(north))?.id);
    expect(taskIn(personal, 'Book the venue')).toBeUndefined();
    // The next new row starts in the default org again.
    await waitFor(() => expect(screen.getByTestId('draft-org-chip').dataset.orgId).toBe(personal));
  });

  test('`^` lists every org; arrows move, Escape closes the suggestions', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    type('Pay ^');
    const suggest = await screen.findByTestId('org-suggest');
    const options = () => within(suggest).getAllByRole('option');
    expect(options().map(optionName)).toEqual(['Personal', 'Northwind', 'Book club']);
    fireEvent.keyDown(activeInput(), { key: 'ArrowDown' });
    fireEvent.keyDown(activeInput(), { key: 'ArrowDown' });
    expect(options()[2]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(activeInput(), { key: 'Enter' });
    expect(activeInput().value).toBe('Pay ^Book ');
    type('Pay ^');
    await screen.findByTestId('org-suggest');
    fireEvent.keyDown(activeInput(), { key: 'Escape' });
    expect(screen.queryByTestId('org-suggest')).toBeNull();
    expect(activeInput().value).toBe('Pay ^');
  });

  test('a changed default org changes the new row’s chip', async () => {
    const { rerender } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(screen.getByTestId('draft-org-chip').dataset.orgId).toBe(personal));
    act(() => {
      rerender({ ...fixtureMe, prefs: { defaultOrgId: club } } as Me);
    });
    type('Read');
    await waitFor(() => expect(screen.getByTestId('draft-org-chip').dataset.orgId).toBe(club));
  });
});
