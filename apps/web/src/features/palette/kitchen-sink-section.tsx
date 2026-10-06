import type { Task } from '@rooster/core/schemas';
import { parseSearchQuery } from '@rooster/core/search';
import { isLocale } from '@rooster/i18n/core';
import { useTranslation } from 'react-i18next';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { Group, Section } from '../dev-ui/layout';
import { TrashRow } from '../settings/data-page';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { buildActions } from './actions';
import {
  type ActionItem,
  buildSections,
  highlightTerms,
  type PaletteSection,
  splitSnippet,
  type TaskItem,
} from './model';
import { PalettePanel } from './palette-panel';

const noop = () => {};

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
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Kitchen-sink entries for the command palette and the Trash (Phase 5, WP 5.3/5.4). */
export function PaletteKitchenSection() {
  const { t, i18n } = useTranslation('palette');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const dateCtx = sampleDateContext(locale);

  const dentist = sampleTask('0192f5d0-0000-7000-8000-000000000001', t('dev.sampleDentist'), {
    dueDate: sampleToday,
  });
  const report = sampleTask('0192f5d0-0000-7000-8000-000000000002', t('dev.sampleReport'), {
    dueDate: '2026-10-12',
  });
  const passport = sampleTask('0192f5d0-0000-7000-8000-000000000003', t('dev.samplePassport'), {
    dueDate: '2026-10-01',
  });
  const item = (
    task: Task,
    section: string,
    terms: string[] = [],
    extra: Partial<TaskItem> = {},
  ): TaskItem => ({
    kind: 'task',
    key: `${section}:${task.id}`,
    task,
    orgId: task.orgId,
    title: highlightTerms(task.title, terms),
    snippet: null,
    chip: { kind: 'group', name: t('dev.sampleGroup') },
    ...extra,
  });

  const actions: ActionItem[] = buildActions({
    orgs: fixtureMe.orgs,
    currentOrg: fixtureMe.orgs[0] ?? null,
    isAdmin: true,
    hasSelection: true,
    canMakeSubtask: true,
    phone: false,
    isAvailable: () => true,
    label: (id) => t(`action.${id}`),
    goToOrgLabel: (name) => t('action.goToOrg', { name }),
  });
  const recents = [item(dentist, 'recent'), item(report, 'recent'), item(passport, 'recent')];

  const query = t('dev.sampleQuery');
  const reportQuery = t('dev.sampleQueryReport');
  const results: PaletteSection[] = buildSections({
    query,
    parsed: parseSearchQuery(query),
    recents: [],
    tasks: [
      item(dentist, 'tasks', [query]),
      item(report, 'tasks', [reportQuery], {
        snippet: splitSnippet(t('dev.sampleSnippet')),
        chip: { kind: 'org', name: t('dev.sampleOrg') },
      }),
    ],
    actions,
  });
  const panel = (
    label: string,
    q: string,
    sections: readonly PaletteSection[],
    extra: Partial<Parameters<typeof PalettePanel>[0]> = {},
  ) => (
    <figure className="flex w-full flex-col gap-2">
      <PalettePanel
        variant="static"
        query={q}
        onQueryChange={noop}
        placeholder={t('placeholder.command')}
        sections={sections}
        activeKey={sections[0]?.items[0]?.key ?? null}
        onActiveKeyChange={noop}
        onSelect={noop}
        onClose={noop}
        dateCtx={dateCtx}
        {...extra}
      />
      <figcaption className="text-xs text-text-muted">{label}</figcaption>
    </figure>
  );

  const actionsOnly = `>${t('action.moveTo').slice(0, 4)}`;
  const noMatch = `>${t('dev.sampleNoMatch')}`;
  const trashed = sampleTask('0192f5d0-0000-7000-8000-000000000004', t('dev.samplePassport'));

  return (
    <Section id="palette" title={t('dev.section')}>
      <Group title={t('dev.empty')}>
        {panel(
          t('dev.empty'),
          '',
          buildSections({ query: '', parsed: parseSearchQuery(''), recents, tasks: [], actions }),
          { scope: { allOrgs: false, onChange: noop } },
        )}
      </Group>
      <Group title={t('dev.results')}>{panel(t('dev.results'), query, results)}</Group>
      <Group title={t('dev.offline')}>
        {panel(
          t('dev.offline'),
          query,
          [{ id: 'tasks', items: [item(dentist, 'tasks', [query])] }],
          { offline: true },
        )}
      </Group>
      <Group title={t('dev.actions')}>
        {panel(
          t('dev.actions'),
          actionsOnly,
          buildSections({
            query: actionsOnly,
            parsed: parseSearchQuery(actionsOnly),
            recents: [],
            tasks: [],
            actions,
          }),
        )}
      </Group>
      <Group title={t('dev.noResults')}>
        {panel(t('dev.noResults'), noMatch, [], { emptyText: t('empty.actions') })}
      </Group>
      <Group title={t('dev.picker')}>
        {panel(t('dev.picker'), '', [{ id: 'tasks', items: [item(report, 'tasks')] }], {
          step: { title: t('picker.title', { count: 1 }), onBack: noop },
        })}
      </Group>
      <Group title={t('dev.trash')}>
        <ul className="flex w-full max-w-pane-max flex-col">
          <TrashRow
            task={trashed}
            meta={t('dev.sampleDeletedBy')}
            confirming={false}
            onConfirm={noop}
            pending={false}
            online
            onRestore={noop}
            onDelete={noop}
          />
          <TrashRow
            task={{ ...trashed, id: `${trashed.id}x` }}
            meta={t('dev.sampleDeletedBy')}
            confirming
            onConfirm={noop}
            pending={false}
            online
            onRestore={noop}
            onDelete={noop}
          />
        </ul>
      </Group>
    </Section>
  );
}
