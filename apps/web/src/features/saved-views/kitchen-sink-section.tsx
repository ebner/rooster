import type { SavedViewQuery, Tag, Task } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import type { Org, OrgMember } from '../../data/types';
import { createListStore, ListStoreContext } from '../../state/list-store';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { Group, Section } from '../dev-ui/layout';
import { AddTaskRow } from '../list/add-row';
import { ListController, type Translate } from '../list/controller';
import { ListContext, type ListContextValue } from '../list/list-context';
import type { Row } from '../list/model/rows';
import { TaskRow } from '../list/task-row';
import { buildEveryoneRows } from '../people/everyone-rows';
import { MemberSectionHeader } from '../people/member-section-header';
import { fixtureIds } from '../shell/fixtures';
import { emptyViewQuery } from './query';
import { QueryChips } from './query-chips';
import { QuerySheet } from './query-sheet';
import { DeleteViewConfirm, ViewCounts, ViewNameInput } from './saved-view-header';
import { savedViewSections } from './saved-view-list';
import type { ViewDraft, ViewEditor } from './use-view-editor';

const orgId = fixtureIds.companyOrg;
const me = fixtureIds.jannik;
const juniper = '0192f5d0-7a1e-7c3a-9f10-00000000e001';
const fika = '0192f5d0-7a1e-7c3a-9f10-00000000e002';

const sampleTags: Tag[] = [
  { id: juniper, orgId, name: 'juniper', color: 'green', createdAt: 0 },
  { id: fika, orgId, name: 'fika', color: 'amber', createdAt: 0 },
];

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
    tagIds: [juniper],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** A header's editor on local state: the specimens edit, nothing is saved. */
function useSampleEditor(initial: ViewDraft, isNew = false): ViewEditor {
  const [draft, setDraft] = useState(initial);
  return {
    draft,
    isNew,
    setName: (name) => setDraft((d) => ({ ...d, name })),
    setQuery: (query) => setDraft((d) => ({ ...d, query })),
    setShared: (shared) => setDraft((d) => ({ ...d, shared })),
    archive: () => undefined,
    remove: () => undefined,
    createTag: () => undefined,
  };
}

function HeaderSpecimen({
  org,
  initial,
  members,
  counts,
  isNew = false,
  children,
}: {
  org: Org;
  initial: ViewDraft;
  members: readonly OrgMember[];
  counts?: { open: number; done: number };
  isNew?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation('views');
  const editor = useSampleEditor(initial, isNew);
  const { draft } = editor;
  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-border p-4">
      <div className="flex h-sheet-header items-center gap-2">
        <h4 className="flex min-w-0 flex-1 items-baseline gap-2 text-lg">
          <ViewNameInput
            name={draft.name}
            onCommit={editor.setName}
            className="max-w-fit field-sizing-content"
          />
          <span className="shrink-0 text-sm font-normal text-text-muted">{org.name}</span>
          {counts && <ViewCounts counts={counts} />}
        </h4>
      </div>
      <QueryChips
        query={draft.query}
        shared={draft.shared}
        isPersonal={org.isPersonal}
        tags={sampleTags}
        members={members}
        meId={me}
        onQuery={editor.setQuery}
        onShared={editor.setShared}
        onCreateTag={() => undefined}
      />
      {draft.shared && !org.isPersonal && (
        <p className="text-xs text-text-muted">{t('saved.sharedNote', { org: org.name })}</p>
      )}
      {isNew && <p className="pt-2 text-sm text-text-muted">{t('saved.newHint')}</p>}
      {children}
    </div>
  );
}

function rowElement(row: Row) {
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

function RowsSpecimen({ rows, label, shared }: { rows: Row[]; label: string; shared: boolean }) {
  const { t, i18n } = useTranslation('list');
  const pipeline = useListPipeline();
  const [store] = useState(() => createListStore());
  const value = useMemo<ListContextValue>(() => {
    const dateCtx = sampleDateContext(isLocale(i18n.language) ? i18n.language : 'en');
    return {
      controller: new ListController({
        orgId,
        userId: me,
        pipeline,
        t: t as unknown as Translate,
        rows: () => rows,
        dateContext: () => dateCtx,
        store,
      }),
      dateCtx,
      parseTitles: true,
      dragEnabled: false,
      shared,
      everyone: shared,
    };
  }, [pipeline, t, i18n.language, rows, store, shared]);
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

/** Phase 13 (ADR 0073 B): a view's header with its query chips, its rows by person, counts. */
export function SavedViewsKitchenSection() {
  const { t, i18n } = useTranslation('views');
  const { t: tPeople } = useTranslation('people');
  const kestrel: Org = {
    id: orgId,
    slug: 'kestrel-lane',
    name: t('all.dev.orgs.kestrel'),
    isPersonal: false,
    avatarEmoji: null,
    color: 'blue',
    role: 'member',
    collapsed: false,
  };
  const personal: Org = {
    ...kestrel,
    id: fixtureIds.personalOrg,
    slug: 'personal',
    name: t('all.dev.orgs.personal'),
    isPersonal: true,
  };
  const members = useMemo<OrgMember[]>(
    () => [
      { userId: me, name: 'Jannik Lunde', email: 'jannik@example.com', image: null, role: 'owner' },
      {
        userId: fixtureIds.anna,
        name: 'Amara Okafor',
        email: 'amara@example.com',
        image: null,
        role: 'member',
      },
      {
        userId: fixtureIds.sara,
        name: 'Sara Nyberg',
        email: 'sara@example.com',
        image: null,
        role: 'member',
      },
    ],
    [],
  );
  const setup = useMemo(() => {
    const queryClient = new QueryClient();
    const transport = createFixtureTransport({ userId: me });
    return { queryClient, transport };
  }, []);
  const project: SavedViewQuery = { ...emptyViewQuery, tags: [juniper] };
  const everything: SavedViewQuery = {
    tags: [juniper, fika],
    tagMode: 'all',
    assignee: fixtureIds.anna,
    due: 'week',
    status: 'any',
  };
  const tasks = useMemo(
    () => [
      sampleTask('v-banners', t('saved.dev.names.launch'), { dueDate: sampleToday }),
      sampleTask('v-venue', tPeople('dev.tasks.offsite'), { assigneeId: fixtureIds.anna }),
      sampleTask('v-sub', tPeople('dev.tasks.minutes'), {
        assigneeId: fixtureIds.anna,
        parentId: 'v-parent',
      }),
      sampleTask('v-parent', tPeople('dev.tasks.budget'), { tagIds: [] }),
      sampleTask('v-loose', tPeople('dev.tasks.slides'), { assigneeId: null }),
    ],
    [t, tPeople],
  );
  const rows = useMemo(() => {
    const sections = savedViewSections(tasks, project, {
      viewerId: me,
      members,
      locale: i18n.language,
      isPersonal: false,
      due: { today: sampleToday, nowMs: Date.UTC(2026, 9, 9, 10), viewerTz: 'Europe/Stockholm' },
      showCompleted: false,
      keep: {},
    });
    return buildEveryoneRows(sections, {
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
      drafts: [],
      draftTask: () => tasks[0] as Task,
      inboxId: 'inbox',
    });
  }, [tasks, members, i18n.language, project]);

  return (
    <Section id="savedViews" title={t('saved.title')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('saved.dev.project')} className="block">
            <HeaderSpecimen
              org={kestrel}
              members={members}
              initial={{ name: t('saved.dev.names.juniper'), query: project, shared: true }}
              counts={{ open: 7, done: 12 }}
            />
          </Group>
          <Group title={t('saved.dev.chipsSet')} className="block">
            <HeaderSpecimen
              org={kestrel}
              members={members}
              initial={{ name: t('saved.dev.names.launch'), query: everything, shared: false }}
            >
              <DeleteViewConfirm
                name={t('saved.dev.names.launch')}
                onConfirm={() => undefined}
                onCancel={() => undefined}
              />
            </HeaderSpecimen>
          </Group>
          <Group title={t('saved.dev.newView')} className="block">
            <HeaderSpecimen
              org={personal}
              members={[]}
              isNew
              initial={{ name: '', query: emptyViewQuery, shared: false }}
            />
          </Group>
          <Group title={t('saved.dev.sections')} className="block">
            <div className="w-full rounded-md border border-border px-3 py-4">
              <RowsSpecimen rows={rows} label={t('saved.dev.sections')} shared />
            </div>
          </Group>
          <Group title={t('saved.dev.sheet')}>
            <SheetSpecimen org={kestrel} members={members} />
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}

function SheetSpecimen({ org, members }: { org: Org; members: readonly OrgMember[] }) {
  const { t } = useTranslation('views');
  const editor = useSampleEditor({
    name: t('saved.dev.names.juniper'),
    query: { ...emptyViewQuery, tags: [juniper] },
    shared: true,
  });
  return (
    <div className="w-sidebar">
      <QuerySheet
        isOpen
        isStatic
        onOpenChange={() => undefined}
        org={org}
        userId={me}
        editor={editor}
        tags={sampleTags}
        members={members}
      />
    </div>
  );
}
