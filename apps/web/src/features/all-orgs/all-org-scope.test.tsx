import type { Task } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ListTransportContext, registerListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { ListPipeline, myListKey } from '../../data/pipeline/pipeline';
import { queryKeys } from '../../data/query-keys';
import { createListStore } from '../../state/list-store';
import { useTagsStore } from '../../state/tags-store';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { BulkBar } from '../list/bulk-bar';
import { ListController, type Translate } from '../list/controller';
import { ListContext } from '../list/list-context';
import { RowTagPicker } from '../list/my-list-view';
import { TaskReminders } from '../list/task-reminders';
import { TitleInput } from '../list/title-input';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { AllListController } from './all-controller';

/** ADR 0073 A3: per-row UI in All organisations works on each task's own org. */

const userId = fixtureMe.user.id;
const north = fixtureIds.companyOrg;
const t: Translate = (key) => key;

async function setup() {
  const transport = createFixtureTransport({
    userId,
    tasks: { 0: [{ title: 'Due today', dueDate: sampleToday }] },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  const pipeline = new ListPipeline({ transport, queryClient, clientId: 'c', backoffMs: () => 0 });
  registerListPipeline(queryClient, transport, pipeline);
  for (const org of fixtureMe.orgs) {
    new QueryObserver(queryClient, {
      queryKey: myListKey(org.id),
      queryFn: () => pipeline.fetch(org.id),
    }).subscribe(() => {});
    await vi.waitFor(() => expect(pipeline.view(org.id)).toBeDefined());
  }
  const store = createListStore();
  const dateCtx = sampleDateContext('en');
  const common = { userId, pipeline, t, store, rows: () => [], dateContext: () => dateCtx };
  const scopes = fixtureMe.orgs.map((org) => ({
    org,
    controller: new ListController({ ...common, orgId: org.id }),
  }));
  const all = new AllListController({
    ...common,
    scopes: () => scopes,
    defaultOrgId: () => fixtureIds.personalOrg,
  });
  const task = (org: string) =>
    Object.values(pipeline.view(org)?.tasks ?? {}).find((x) => x.title === 'Due today') as Task;
  const wrap = (children: React.ReactNode, controller: ListController = all) => (
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <ListContext.Provider
          value={{ controller, dateCtx, parseTitles: true, dragEnabled: false }}
        >
          {children}
        </ListContext.Provider>
      </ListTransportContext.Provider>
    </QueryClientProvider>
  );
  return { transport, pipeline, all, scopes, store, task, dateCtx, wrap };
}

describe('All organisations: per-row UI', () => {
  test('a reminder added in a row’s date picker shows at once, from its org’s queue', async () => {
    const { transport, all, task, dateCtx, wrap } = await setup();
    const target = task(north);
    // The server never answers: only the queued op can show the reminder.
    transport.send = () => new Promise(() => undefined);
    const slot = {
      due: {
        dueDate: target.dueDate,
        dueTime: null,
        dueTz: null,
        startDate: null,
      },
      autoFocus: false,
      applyDraft: () => undefined,
    };
    render(wrap(<TaskReminders taskId={target.id} controller={all} ctx={dateCtx} slot={slot} />));
    const section = await screen.findByTestId('reminder-section');
    const preset = await waitFor(() => {
      const button = section.querySelector('fieldset button') as HTMLButtonElement | null;
      expect(button?.disabled).toBe(false);
      return button as HTMLButtonElement;
    });
    fireEvent.click(preset);
    // The preset now exists: disabled, from the queued `reminder.create` in the task's org.
    await waitFor(() => expect(preset.disabled).toBe(true));
  });

  test('the bulk bar offers "Move to organisation" in an org’s list, not in All', async () => {
    const { all, scopes, task, wrap } = await setup();
    const own = scopes[1]?.controller as ListController;
    const ids = [task(north).id];
    const { unmount } = render(wrap(<BulkBar ids={ids} />, own));
    const bar = screen.getByRole('toolbar');
    expect(within(bar).getByRole('button', { name: 'Move to organisation…' })).toBeTruthy();
    unmount();
    render(wrap(<BulkBar ids={ids} />, all));
    expect(
      within(screen.getByRole('toolbar')).queryByRole('button', { name: 'Move to organisation…' }),
    ).toBeNull();
  });
});

/** The tags store while All organisations is behind the pane: every org's tags. */
function everyOrgsTags() {
  const tag = (id: string, orgId: string, name: string) => ({
    id,
    orgId,
    name,
    color: 'blue' as const,
    createdAt: 0,
  });
  useTagsStore.setState({
    byId: {
      t1: tag('t1', north, 'northwind-tag'),
      t2: tag('t2', fixtureIds.personalOrg, 'personal-tag'),
    },
  });
}

describe('tags of one org, with every org’s in the store', () => {
  test('an org’s tag picker (the pane’s subtasks) offers only that org’s tags', async () => {
    const { scopes, task, wrap } = await setup();
    everyOrgsTags();
    const own = scopes[1]?.controller as ListController;
    const anchor = document.createElement('button');
    document.body.append(anchor);
    render(wrap(<RowTagPicker anchor={anchor} ids={[task(north).id]} controller={own} />, own));
    const list = await screen.findByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['northwind-tag']);
  });

  test('`#` in a subtask’s new row suggests only its org’s tags', async () => {
    const { scopes, store, task, wrap } = await setup();
    everyOrgsTags();
    const own = scopes[1]?.controller as ListController;
    store
      .getState()
      .addDraft({ id: 'draft', groupId: '', afterId: null, parentId: task(north).id });
    render(
      wrap(
        <TitleInput rowId="draft" initialValue="" caret="end" caretSeq={0} label="Title" />,
        own,
      ),
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    input.value = 'Ask #';
    input.setSelectionRange(5, 5);
    fireEvent.input(input);
    const list = await screen.findByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['northwind-tag']);
  });
});

describe('pasting into a new row of All organisations', () => {
  test('with an org’s list unavailable, Enter keeps the paste and its chip', async () => {
    const { pipeline, store, wrap } = await setup();
    const view = pipeline.view.bind(pipeline);
    vi.spyOn(pipeline, 'view').mockImplementation((org) => (org === north ? undefined : view(org)));
    store.getState().addDraft({ id: 'draft', groupId: '', afterId: null, sectionId: 'today' });
    store.getState().edit('draft', 'end');
    render(
      wrap(<TitleInput rowId="draft" initialValue="" caret="end" caretSeq={0} label="Title" />),
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'First task\nSecond task ^North' },
    });
    expect(screen.getByText('Create 2 tasks? ↵')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Create 2 tasks? ↵')).toBeTruthy();
    expect(store.getState().drafts.map((d) => d.id)).toEqual(['draft']);
    expect(pipeline.pendingOps(fixtureIds.personalOrg)).toHaveLength(0);
  });
});
