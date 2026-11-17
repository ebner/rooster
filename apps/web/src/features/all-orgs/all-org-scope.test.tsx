import type { Task } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ListTransportContext, registerListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { ListPipeline, myListKey } from '../../data/pipeline/pipeline';
import { queryKeys } from '../../data/query-keys';
import { createListStore } from '../../state/list-store';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { BulkBar } from '../list/bulk-bar';
import { ListController, type Translate } from '../list/controller';
import { ListContext } from '../list/list-context';
import { TaskReminders } from '../list/task-reminders';
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
  return { transport, all, scopes, task, dateCtx, wrap };
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
