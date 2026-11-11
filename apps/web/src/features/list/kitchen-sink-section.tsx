import { addDays, todayIn } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { cn } from '../../lib/cn';
import { createListStore, ListStoreContext, upcomingRowId } from '../../state/list-store';
import { Menu } from '../../ui/menu';
import { popoverSurface } from '../../ui/popover';
import { useViewerDateContext } from '../dates';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { BulkBar } from './bulk-bar';
import { ListController, type Translate } from './controller';
import { ListHeaderMenu, ListMenuItems, type ListMenuView } from './header-actions';
import { ListContext, type ListContextValue } from './list-context';
import type { TaskRow as TaskRowModel, UpcomingRow } from './model/rows';
import { MyListView } from './my-list-view';
import { RecurringDeleteBody, RecurringDeleteSheet } from './recurring-delete';
import { TaskRow } from './task-row';
import { UpcomingHeader } from './upcoming-header';

const noop = () => {};

const headerMenuViews = [
  ['my', 'dev.headerMenuMy'],
  ['smart', 'dev.headerMenuSmart'],
  ['everyone', 'dev.headerMenuEveryone'],
] as const satisfies readonly (readonly [ListMenuView, string])[];

const fixtureUser = '01900000-0000-7000-8000-000000000001';
const fixtureOrg = '01900000-0000-7000-8000-0000000000aa';

/** A static bulk bar (it floats at the bottom of the viewport in the app). */
function BulkBarSpecimen() {
  const pipeline = useListPipeline();
  const dateCtx = useViewerDateContext();
  const { t } = useTranslation('list');
  const value = useMemo(() => {
    const controller = new ListController({
      orgId: fixtureOrg,
      userId: fixtureUser,
      pipeline,
      t: t as unknown as ConstructorParameters<typeof ListController>[0]['t'],
      rows: () => [],
      dateContext: () => dateCtx,
    });
    return { controller, dateCtx, parseTitles: true, dragEnabled: false };
  }, [pipeline, dateCtx, t]);
  return (
    <ListContext.Provider value={value}>
      <BulkBar ids={['a', 'b', 'c']} className="static translate-x-0 animate-none" />
    </ListContext.Provider>
  );
}

/**
 * The Upcoming section (ADR 0068), folded and open, on a static context of its own: its
 * header, and rows with their date, repeat icon and the group they go back to.
 */
function UpcomingSpecimen({ open }: { open: boolean }) {
  const { t } = useTranslation('list');
  const pipeline = useListPipeline();
  const dateCtx = useViewerDateContext();
  const [store] = useState(() => createListStore());
  const rows = useMemo(() => {
    const task = (id: string, title: string, dueDate: string): Task => ({
      id,
      orgId: fixtureOrg,
      seq: null,
      parentId: null,
      subtaskPosition: null,
      title,
      assigneeId: fixtureUser,
      createdBy: fixtureUser,
      dueDate,
      dueTime: null,
      dueTz: null,
      startDate: null,
      recurrence: 'FREQ=WEEKLY',
      recurrenceBasis: 'due',
      tagIds: [],
      completedAt: null,
      hasDescription: false,
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
      placement: { groupId: 'today', position: 'a0' },
      createdAt: 0,
      updatedAt: 0,
    });
    const row = (item: Task, groupChip: string): TaskRowModel => ({
      kind: 'task',
      id: item.id,
      task: item,
      groupId: 'today',
      draft: false,
      level: 2,
      parentId: null,
      expandable: false,
      expanded: false,
      breadcrumb: null,
      groupChip,
      upcoming: true,
    });
    const header: UpcomingRow = { kind: 'upcoming', id: upcomingRowId, count: 2, collapsed: !open };
    return {
      header,
      tasks: [
        row(
          task('upcoming-1', t('dev.tasks.weekly'), addDays(dateCtx.today, 1)),
          t('dev.groups.today'),
        ),
        row(
          task('upcoming-2', t('dev.tasks.bins'), addDays(dateCtx.today, 3)),
          t('dev.groups.prio'),
        ),
      ],
    };
  }, [open, t, dateCtx.today]);
  const value = useMemo<ListContextValue>(() => {
    const controller = new ListController({
      orgId: fixtureOrg,
      userId: fixtureUser,
      pipeline,
      t: t as unknown as Translate,
      rows: () => [rows.header, ...rows.tasks],
      dateContext: () => dateCtx,
      store,
    });
    return { controller, dateCtx, parseTitles: true, dragEnabled: true };
  }, [pipeline, t, rows, dateCtx, store]);
  return (
    <ListStoreContext.Provider value={store}>
      <ListContext.Provider value={value}>
        <div role="treegrid" aria-label={t('upcoming.name')} className="flex w-full flex-col">
          <UpcomingHeader row={rows.header} />
          {open && rows.tasks.map((row) => <TaskRow key={row.id} row={row} />)}
        </div>
      </ListContext.Provider>
    </ListStoreContext.Provider>
  );
}

/**
 * Kitchen-sink entry for WP 2.3–2.8: a live My tasks list on an in-memory server (every key,
 * drag and drop, groups and undo work), and the bulk bar.
 */
export function ListSection() {
  const { t } = useTranslation('list');
  const setup = useMemo(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = todayIn(zone, Date.now());
    const transport = createFixtureTransport({
      userId: fixtureUser,
      tags: [
        { name: 'mail', color: 'amber' },
        { name: 'work', color: 'red' },
      ],
      groupNames: [
        t('dev.groups.inbox'),
        t('dev.groups.today'),
        t('dev.groups.prio'),
        t('dev.groups.upcoming'),
      ],
      tasks: {
        1: [
          {
            title: t('dev.tasks.reply'),
            description: t('dev.tasks.replyNotes'),
            tags: ['mail', 'work', 'finance', 'urgent'],
            expanded: true,
            subtasks: [t('dev.tasks.passport'), { title: t('dev.tasks.done'), completed: true }],
          },
          { title: t('dev.tasks.dentist'), dueDate: today },
          { title: t('dev.tasks.done'), completed: true },
        ],
        2: [
          {
            title: t('dev.tasks.plan'),
            description: t('dev.tasks.planNotes'),
            dueDate: addDays(today, 4),
          },
          { title: t('dev.tasks.passport'), dueDate: addDays(today, -2) },
        ],
        3: [
          { title: t('dev.tasks.offsite'), dueDate: addDays(today, 1) },
          // ADR 0068: a repeating task whose day hasn't come waits in Upcoming at the end.
          { title: t('dev.tasks.bins'), dueDate: addDays(today, 3), recurrence: 'FREQ=WEEKLY' },
          // P10: the bell, the paperclip and the repeat icon in the row meta.
          {
            title: t('dev.tasks.weekly'),
            dueDate: addDays(today, 1),
            dueTime: '14:00',
            dueTz: zone,
            recurrence: 'FREQ=WEEKLY',
            reminders: [60],
            attachments: 2,
          },
        ],
      },
      timezone: zone,
    });
    return { transport, queryClient: new QueryClient() };
  }, [t]);

  return (
    <Section id="list" title={t('dev.section')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('dev.live')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <MyListView orgId={fixtureOrg} userId={fixtureUser} label={t('dev.live')} />
            </div>
          </Group>
          <Group title={t('dev.headerMenu')}>
            {headerMenuViews.map(([view, label]) => (
              <Specimen key={view} label={t(label)}>
                <div className={cn(popoverSurface, 'p-1')}>
                  <Menu aria-label={t('header.menu')}>
                    <ListMenuItems orgId={fixtureOrg} view={view} />
                  </Menu>
                </div>
              </Specimen>
            ))}
            <Specimen label={t('header.menu')}>
              <ListHeaderMenu orgId={fixtureOrg} view="my" />
            </Specimen>
          </Group>
          <Group title={t('dev.bulkBar')}>
            <BulkBarSpecimen />
          </Group>
          <Group title={t('dev.upcomingCollapsed')} className="block">
            <div className="w-full rounded-md border border-border px-3 pb-4">
              <UpcomingSpecimen open={false} />
            </div>
          </Group>
          <Group title={t('dev.upcomingOpen')} className="block">
            <div className="w-full rounded-md border border-border px-3 pb-4">
              <UpcomingSpecimen open />
            </div>
          </Group>
          <Group title={t('recurringDelete.title')}>
            <Specimen label={t('dev.recurringDeletePopover')}>
              <div className={cn(popoverSurface, 'w-date-popover p-3')}>
                <RecurringDeleteBody
                  title={t('dev.tasks.weekly')}
                  onChoose={noop}
                  onCancel={noop}
                  autoFocus={false}
                  data-force="focus"
                />
              </div>
            </Specimen>
            <Specimen label={t('dev.recurringDeleteSheet')}>
              <RecurringDeleteSheet
                isOpen
                isStatic
                title={t('dev.tasks.weekly')}
                onChoose={noop}
                onCancel={noop}
              />
            </Specimen>
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}
