import { addDays } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import type { Org } from '../../data/types';
import { createListStore, ListStoreContext } from '../../state/list-store';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { Group, Section } from '../dev-ui/layout';
import { ListController, type Translate } from '../list/controller';
import { ListContext, type ListContextValue } from '../list/list-context';
import type { Row } from '../list/model/rows';
import { SectionHeader } from '../list/section-header';
import { TaskRow } from '../list/task-row';
import { fixtureIds } from '../shell/fixtures';
import { OrgChip } from './org-chip';
import { OrgSuggestList } from './org-suggest';

function sampleTask(id: string, orgId: string, title: string, dueDate: string): Task {
  return {
    id,
    orgId,
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title,
    assigneeId: fixtureIds.jannik,
    createdBy: fixtureIds.jannik,
    dueDate,
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
  };
}

function useSampleOrgs(): Org[] {
  const { t } = useTranslation('views');
  return useMemo(
    () => [
      {
        id: fixtureIds.personalOrg,
        slug: 'personal',
        name: t('all.dev.orgs.personal'),
        isPersonal: true,
        avatarEmoji: '🏡',
        color: 'green',
        role: 'owner',
        collapsed: false,
      },
      {
        id: fixtureIds.companyOrg,
        slug: 'kestrel-lane',
        name: t('all.dev.orgs.kestrel'),
        isPersonal: false,
        avatarEmoji: null,
        color: 'blue',
        role: 'member',
        collapsed: false,
      },
      {
        id: fixtureIds.clubOrg,
        slug: 'club',
        name: t('all.dev.orgs.club'),
        isPersonal: false,
        avatarEmoji: '🚣',
        color: 'amber',
        role: 'member',
        collapsed: false,
      },
    ],
    [t],
  );
}

function rowElement(row: Row): ReactElement | null {
  if (row.kind === 'section') return <SectionHeader key={row.id} row={row} />;
  if (row.kind === 'task') return <TaskRow key={row.id} row={row} />;
  return null;
}

/** Static rows of All · Today on a context of their own (no server). */
function RowsSpecimen({ orgs }: { orgs: readonly Org[] }) {
  const { t, i18n } = useTranslation('list');
  const { t: tViews } = useTranslation('views');
  const pipeline = useListPipeline();
  const [store] = useState(() => createListStore());
  const [personal, kestrel, club] = orgs as [Org, Org, Org];
  const rows = useMemo<Row[]>(() => {
    const task = (task: Task, sectionId: string, groupChip: string): Row => ({
      kind: 'task',
      id: task.id,
      task,
      groupId: 'g',
      draft: false,
      level: 2,
      parentId: null,
      expandable: false,
      expanded: false,
      breadcrumb: null,
      sectionId,
      groupChip,
      orgId: task.orgId,
    });
    const late = addDays(sampleToday, -2);
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
      task(
        sampleTask('a-late', kestrel.id, tViews('dev.tasks.slides'), late),
        'overdue',
        tViews('dev.groups.prio'),
      ),
      {
        kind: 'section',
        id: 'section:today',
        sectionId: 'today',
        sectionKind: 'today',
        date: sampleToday,
        count: 2,
        first: false,
      },
      task(
        sampleTask('a-bank', personal.id, tViews('dev.tasks.bank'), sampleToday),
        'today',
        tViews('dev.groups.inbox'),
      ),
      task(
        sampleTask('a-club', club.id, tViews('dev.tasks.offsite'), sampleToday),
        'today',
        tViews('dev.groups.work'),
      ),
    ];
  }, [personal, kestrel, club, tViews]);
  const value = useMemo<ListContextValue>(() => {
    const dateCtx = sampleDateContext(isLocale(i18n.language) ? i18n.language : 'en');
    const controller = new ListController({
      orgId: personal.id,
      userId: fixtureIds.jannik,
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
      view: 'today',
      orgs: new Map(orgs.map((org) => [org.id, org])),
    };
  }, [pipeline, t, i18n.language, rows, store, orgs, personal]);
  return (
    <ListStoreContext.Provider value={store}>
      <ListContext.Provider value={value}>
        <div role="treegrid" aria-label={tViews('all.dev.rows')} className="flex w-full flex-col">
          {rows.map(rowElement)}
        </div>
      </ListContext.Provider>
    </ListStoreContext.Provider>
  );
}

/** A new row's title as typed, its tokens highlighted, then its org chip (ADR 0073 A4). */
function DraftSpecimen({ title, token, org }: { title: string; token?: string; org: Org }) {
  return (
    <div className="flex h-row w-full items-center rounded-sm ps-8 pe-2 text-base">
      <span className="min-w-0 truncate text-text">
        {title}
        {token && (
          <>
            {' '}
            <mark className="rounded-2xs bg-bg-accent-subtle text-text">{token}</mark>
          </>
        )}
      </span>
      <OrgChip org={org} draft className="ms-2" />
    </div>
  );
}

/** Phase 13 (ADR 0073 A): All organisations: rows with org chips, the draft's org chip. */
export function AllOrgsKitchenSection() {
  const { t } = useTranslation('views');
  const orgs = useSampleOrgs();
  const [personal, kestrel] = orgs as [Org, Org, Org];
  const [active, setActive] = useState(1);
  const setup = useMemo(
    () => ({
      queryClient: new QueryClient(),
      transport: createFixtureTransport({ userId: fixtureIds.jannik }),
    }),
    [],
  );
  const draftDefault = t('all.dev.draftDefault');
  const draftToken = t('all.dev.draftToken');
  const tokenAt = draftToken.lastIndexOf('^');
  return (
    <Section id="allOrgs" title={t('all.title')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('all.dev.rows')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <RowsSpecimen orgs={orgs} />
            </div>
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
      <Group title={t('all.dev.draft')} className="flex-col items-stretch">
        <div className="w-full rounded-md border border-border px-3 py-2">
          <DraftSpecimen title={draftDefault} org={personal} />
          <DraftSpecimen
            title={draftToken.slice(0, tokenAt).trimEnd()}
            token={draftToken.slice(tokenAt)}
            org={kestrel}
          />
        </div>
      </Group>
      <Group title={t('all.dev.suggest')}>
        <OrgSuggestList id="kitchen-org-suggest" orgs={orgs} active={active} onPick={setActive} />
        <div className="flex flex-col gap-2">
          {orgs.map((org) => (
            <OrgChip key={org.id} org={org} />
          ))}
        </div>
      </Group>
    </Section>
  );
}
