import { addDays } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { SMART_VIEWS } from '@rooster/core/views';
import { isLocale } from '@rooster/i18n/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { createListStore, ListStoreContext } from '../../state/list-store';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { Group, Section } from '../dev-ui/layout';
import { AddTaskRow } from '../list/add-row';
import { ListController, type Translate } from '../list/controller';
import { ListContext, type ListContextValue } from '../list/list-context';
import type { EmptyRow, Row } from '../list/model/rows';
import { SectionHeader } from '../list/section-header';
import { GroupChip } from '../list/task-meta';
import { TaskRow } from '../list/task-row';
import { ViewEmptyState } from '../list/view-empty';
import { fixtureIds } from '../shell/fixtures';
import { SidebarItem } from '../shell/sidebar-item';
import { sidebarViews } from '../shell/sidebar-views';

function sampleTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    orgId: fixtureIds.personalOrg,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title,
    assigneeId: fixtureIds.jannik,
    createdBy: fixtureIds.jannik,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function rowElement(row: Row): ReactElement | null {
  switch (row.kind) {
    case 'section':
      return <SectionHeader key={row.id} row={row} />;
    case 'task':
      return <TaskRow key={row.id} row={row} />;
    case 'add':
      return <AddTaskRow key={row.id} row={row} />;
    case 'empty':
      return <ViewEmptyState key={row.id} row={row} />;
    default:
      return null;
  }
}

/** Static specimen rows on a context of their own (no server; adds do nothing). */
function Specimen({ rows, label }: { rows: readonly Row[]; label: string }) {
  const { t, i18n } = useTranslation('list');
  const pipeline = useListPipeline();
  const [store] = useState(() => createListStore());
  const value = useMemo<ListContextValue>(() => {
    const dateCtx = sampleDateContext(isLocale(i18n.language) ? i18n.language : 'en');
    const controller = new ListController({
      orgId: fixtureIds.personalOrg,
      userId: fixtureIds.jannik,
      pipeline,
      t: t as unknown as Translate,
      rows: () => rows,
      dateContext: () => dateCtx,
      store,
    });
    return { controller, dateCtx, parseTitles: true, dragEnabled: false, view: 'today' };
  }, [pipeline, t, i18n.language, rows, store]);
  return (
    <ListStoreContext.Provider value={store}>
      <ListContext.Provider value={value}>
        <div role="treegrid" aria-label={label} className="flex w-full flex-col">
          {rows.map(rowElement)}
        </div>
      </ListContext.Provider>
    </ListStoreContext.Provider>
  );
}

/** The views' sidebar entries with sample badges (0, n, Overdue in danger, none). */
function SidebarSpecimens() {
  const { t } = useTranslation('shell');
  const counts: Record<string, number> = { my: 7, today: 4, overdue: 2 };
  return (
    <>
      <div className="flex w-sidebar flex-col gap-0.5 rounded-md bg-bg-sidebar p-2">
        {sidebarViews.map((view, i) => (
          <SidebarItem
            key={view.id}
            icon={view.icon}
            label={t(`view.${view.id}`)}
            href="#views"
            isActive={i === 1}
            count={view.badge ? counts[view.id] : undefined}
            countTone={view.badge === 'danger' ? 'danger' : 'default'}
          />
        ))}
        <SidebarItem
          icon={CircleAlert}
          label={t('view.overdue')}
          href="#views"
          count={0}
          countTone="danger"
        />
      </div>
      <div className="flex w-rail flex-col items-center gap-0.5 rounded-md bg-bg-sidebar p-2">
        {sidebarViews.map((view) => (
          <SidebarItem
            key={view.id}
            rail
            icon={view.icon}
            label={t(`view.${view.id}`)}
            href="#views"
          />
        ))}
      </div>
    </>
  );
}

/** Kitchen-sink entries for the smart views (Phase 5, WP 5.1). */
export function ViewsKitchenSection() {
  const { t } = useTranslation('views');
  const setup = useMemo(
    () => ({
      queryClient: new QueryClient(),
      transport: createFixtureTransport({ userId: fixtureIds.jannik }),
    }),
    [],
  );

  const todayRows = useMemo<Row[]>(() => {
    const late = sampleTask('v-late', t('dev.tasks.passport'), {
      dueDate: addDays(sampleToday, -2),
    });
    const bank = sampleTask('v-bank', t('dev.tasks.bank'), { dueDate: sampleToday });
    const child = sampleTask('v-child', t('dev.tasks.slides'), {
      dueDate: sampleToday,
      parentId: 'v-parent',
    });
    const task = (t: Task, groupChip: string, breadcrumb: string | null = null): Row => ({
      kind: 'task',
      id: t.id,
      task: t,
      groupId: 'g',
      draft: false,
      level: 2,
      parentId: null,
      expandable: false,
      expanded: false,
      breadcrumb,
      sectionId: t.dueDate === sampleToday ? 'today' : 'overdue',
      groupChip,
    });
    return [
      {
        kind: 'section',
        id: 'section:overdue',
        sectionId: 'overdue',
        sectionKind: 'overdue',
        date: null,
        count: 1,
        first: true,
      },
      task(late, t('dev.groups.prio')),
      {
        kind: 'section',
        id: 'section:today',
        sectionId: 'today',
        sectionKind: 'today',
        date: sampleToday,
        count: 2,
        first: false,
      },
      task(bank, t('dev.groups.inbox')),
      task(child, t('dev.groups.work'), t('dev.tasks.offsite')),
      { kind: 'add', id: 'add:section:today', groupId: 'g', sectionId: 'today' },
    ];
  }, [t]);

  const weekRows = useMemo<Row[]>(
    () =>
      [0, 1, 2].map((offset) => ({
        kind: 'section',
        id: `section:${offset}`,
        sectionId: addDays(sampleToday, offset),
        sectionKind: 'day',
        date: addDays(sampleToday, offset),
        count: 0,
        first: offset === 0,
      })),
    [],
  );

  const emptyRows = useMemo(
    () =>
      SMART_VIEWS.map(
        (view): EmptyRow => ({
          kind: 'empty',
          id: `empty:${view}`,
          view,
          canAdd: view !== 'overdue',
        }),
      ),
    [],
  );

  return (
    <Section id="views" title={t('dev.section')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('dev.today')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <Specimen rows={todayRows} label={t('dev.today')} />
            </div>
          </Group>
          <Group title={t('dev.week')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <Specimen rows={weekRows} label={t('dev.week')} />
            </div>
          </Group>
          <Group title={t('dev.chip')}>
            <GroupChip name={t('dev.groups.inbox')} />
            <GroupChip name={t('dev.groups.prio')} />
            <GroupChip name={t('dev.groups.long')} />
          </Group>
          <Group title={t('dev.empty')}>
            {emptyRows.map((row) => (
              <div key={row.id} className="w-date-popover rounded-md border border-border">
                <Specimen rows={[row]} label={t(`empty.${row.view}`)} />
              </div>
            ))}
          </Group>
          <Group title={t('dev.sidebar')}>
            <SidebarSpecimens />
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}
