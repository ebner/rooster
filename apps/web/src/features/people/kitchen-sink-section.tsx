import { addDays } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getListPipeline, ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import type { OrgMember } from '../../data/types';
import { cn } from '../../lib/cn';
import { createListStore, ListStoreContext, sectionRowId } from '../../state/list-store';
import { Button } from '../../ui/button';
import { popoverSurface } from '../../ui/popover';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { Group, Section } from '../dev-ui/layout';
import { AddTaskRow } from '../list/add-row';
import { ListController, type Translate } from '../list/controller';
import { ListContext, type ListContextValue } from '../list/list-context';
import type { Row } from '../list/model/rows';
import { TaskRow } from '../list/task-row';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { AssigneeField } from './assignee-field';
import { AssigneeList, AssigneePicker } from './assignee-picker';
import { AssigneeSheet } from './assignee-sheet';
import { EveryoneFilterButton } from './everyone-filters';
import { everyoneSections, memberSectionId } from './everyone-model';
import { buildEveryoneRows } from './everyone-rows';
import { MemberSectionHeader } from './member-section-header';

const orgId = fixtureIds.companyOrg;
const me = fixtureIds.jannik;

function sampleTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    orgId,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title,
    assigneeId: me,
    createdBy: me,
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
      return <MemberSectionHeader key={row.id} row={row} />;
    case 'task':
      return <TaskRow key={row.id} row={row} />;
    case 'add':
      return <AddTaskRow key={row.id} row={row} />;
    default:
      return null;
  }
}

/** Static rows on a list context of their own; `force` sets UI states (selection, a drop). */
function RowsSpecimen({
  rows,
  label,
  everyone,
  force,
}: {
  rows: readonly Row[];
  label: string;
  everyone: boolean;
  force?: Parameters<typeof createListStore>[0];
}) {
  const { t, i18n } = useTranslation('list');
  const pipeline = useListPipeline();
  const [store] = useState(() => createListStore(force));
  const value = useMemo<ListContextValue>(() => {
    const dateCtx = sampleDateContext(isLocale(i18n.language) ? i18n.language : 'en');
    const controller = new ListController({
      orgId,
      userId: me,
      pipeline,
      t: t as unknown as Translate,
      rows: () => rows,
      dateContext: () => dateCtx,
      store,
    });
    return {
      controller,
      dateCtx,
      parseTitles: true,
      dragEnabled: false,
      shared: true,
      everyone,
    };
  }, [pipeline, t, i18n.language, rows, store, everyone]);
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

/** The real anchored picker, opened from a button. */
function PickerDemo({ members }: { members: readonly OrgMember[] }) {
  const { t } = useTranslation('people');
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(fixtureIds.anna);
  return (
    <span ref={anchor} className="inline-flex">
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        {t('picker.placeholder')}
      </Button>
      {open && anchor.current && (
        <AssigneePicker
          anchor={anchor.current}
          members={members}
          meId={me}
          current={current}
          label={t('picker.list')}
          onPick={setCurrent}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function SheetDemo({ members }: { members: readonly OrgMember[] }) {
  const { t } = useTranslation('people');
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  return (
    <>
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        {t('dev.openSheet')}
      </Button>
      <AssigneeSheet
        isOpen={open}
        onOpenChange={setOpen}
        members={members}
        meId={me}
        current={current}
        subject={t('dev.tasks.budget')}
        onPick={setCurrent}
      />
    </>
  );
}

/** Kitchen-sink entries for assignment and Everyone's tasks (P6, WP 6.1–6.2). */
export function PeopleKitchenSection() {
  const { t, i18n } = useTranslation('people');
  const members = useMemo<OrgMember[]>(
    () => [
      {
        userId: me,
        name: fixtureMe.user.name,
        email: 'jannik@example.com',
        image: null,
        role: 'owner',
      },
      {
        userId: fixtureIds.anna,
        name: t('dev.people.anna'),
        email: 'anna@example.com',
        image: null,
        role: 'member',
      },
      {
        userId: fixtureIds.sara,
        name: t('dev.people.bob'),
        email: 'bo@example.com',
        image: null,
        role: 'member',
      },
      {
        userId: fixtureIds.olof,
        name: t('dev.people.chen'),
        email: 'chen@example.com',
        image: null,
        role: 'member',
      },
    ],
    [t],
  );
  // A new client per locale: the members' names are translated fixtures.
  const setup = useMemo(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.me, fixtureMe);
    queryClient.setQueryData(queryKeys.orgMembers(orgId), members);
    const transport = createFixtureTransport({ userId: me, members });
    // The fields assign through the pipeline, which needs the org's list state.
    getListPipeline(queryClient, transport).seed(orgId, transport.state(orgId));
    return { queryClient, transport };
  }, [members]);

  const tasks = useMemo(
    () => [
      sampleTask('p-budget', t('dev.tasks.budget'), { dueDate: addDays(sampleToday, -1) }),
      sampleTask('p-invoice', t('dev.tasks.invoice'), {
        assigneeId: fixtureIds.anna,
        dueDate: sampleToday,
      }),
      sampleTask('p-offsite', t('dev.tasks.offsite'), {
        assigneeId: fixtureIds.anna,
        dueDate: addDays(sampleToday, 4),
        hasDescription: true,
      }),
      sampleTask('p-slides', t('dev.tasks.slides'), { assigneeId: fixtureIds.sara }),
      sampleTask('p-minutes', t('dev.tasks.minutes'), {
        assigneeId: null,
        parentId: 'p-budget',
      }),
    ],
    [t],
  );

  const everyoneRows = useMemo(() => {
    const sections = everyoneSections(tasks, {
      viewerId: me,
      members,
      locale: i18n.language,
      filters: { due: 'any', members: [] },
      tagIds: [],
      due: { today: sampleToday, nowMs: Date.UTC(2026, 9, 9, 10), viewerTz: 'Europe/Stockholm' },
      showCompleted: false,
    });
    return buildEveryoneRows(sections, {
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
      drafts: [],
      draftTask: () => tasks[0] as Task,
      inboxId: 'inbox',
    });
  }, [tasks, members, i18n.language]);

  // My tasks: a parent of mine with subtasks, one of them Anna's (FR-TASK-10).
  const subtaskRows = useMemo<Row[]>(() => {
    const parent = sampleTask('p-parent', t('dev.tasks.offsite'), {
      counts: { subtasks: 2, subtasksDone: 0, comments: 0, attachments: 0 },
    });
    const mine = sampleTask('p-sub-mine', t('dev.tasks.invoice'), { parentId: parent.id });
    const annas = sampleTask('p-sub-anna', t('dev.tasks.slides'), {
      parentId: parent.id,
      assigneeId: fixtureIds.anna,
    });
    const row = (task: Task, level: number, parentId: string | null): Row => ({
      kind: 'task',
      id: task.id,
      task,
      groupId: 'g',
      draft: false,
      level,
      parentId,
      expandable: level === 2,
      expanded: level === 2,
      breadcrumb: null,
    });
    return [row(parent, 2, null), row(mine, 3, parent.id), row(annas, 3, parent.id)];
  }, [t]);

  const sectionsOnly = everyoneRows.filter((row) => row.kind === 'section');

  return (
    <Section id="people" title={t('dev.section')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('dev.picker')}>
            <div
              data-testid="assignee-picker-preview"
              className={cn(popoverSurface, 'flex w-date-popover flex-col bg-bg-elevated')}
            >
              <AssigneeList
                members={members}
                meId={me}
                current={fixtureIds.anna}
                onPick={() => undefined}
                onClose={() => undefined}
                autoFocus={false}
              />
            </div>
            <PickerDemo members={members} />
          </Group>
          <Group title={t('dev.sheet')}>
            <SheetDemo members={members} />
          </Group>
          <Group title={t('dev.field')}>
            <div className="w-date-popover">
              <AssigneeField
                orgId={orgId}
                task={{ id: 'p-invoice', orgId, assigneeId: fixtureIds.anna }}
                variant="pane"
              />
            </div>
            <div className="w-date-popover">
              <AssigneeField
                orgId={orgId}
                task={{ id: 'p-minutes', orgId, assigneeId: null }}
                variant="pane"
              />
            </div>
            <div className="w-sidebar">
              <AssigneeField
                orgId={orgId}
                task={{ id: 'p-budget', orgId, assigneeId: me }}
                variant="sheet"
              />
            </div>
          </Group>
          <Group title={t('dev.rows')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <RowsSpecimen rows={subtaskRows} label={t('dev.rows')} everyone={false} />
            </div>
          </Group>
          <Group title={t('dev.everyone')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <RowsSpecimen
                rows={everyoneRows}
                label={t('dev.everyone')}
                everyone
                force={{
                  cursor: 'p-invoice',
                  selected: { 'p-invoice': true },
                  // A reassign drag over Bob's section.
                  drop: { rowId: sectionRowId(memberSectionId(fixtureIds.sara)), edge: 'inside' },
                }}
              />
            </div>
            <div className="mt-4 w-full rounded-md border border-border px-3 py-4">
              <RowsSpecimen rows={sectionsOnly} label={t('dev.everyone')} everyone />
            </div>
          </Group>
          <Group title={t('dev.filters')}>
            <EveryoneFilterButton members={members} meId={me} />
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}
