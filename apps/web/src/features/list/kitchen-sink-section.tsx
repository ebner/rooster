import { addDays, todayIn } from '@rooster/core/dates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext, useListPipeline } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { useViewerDateContext } from '../dates';
import { Group, Section } from '../dev-ui/layout';
import { BulkBar } from './bulk-bar';
import { ListController } from './controller';
import { ListContext } from './list-context';
import { MyListView } from './my-list-view';

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
 * Kitchen-sink entry for WP 2.3–2.8: a live My tasks list on an in-memory server (every key,
 * drag and drop, groups and undo work), and the bulk bar.
 */
export function ListSection() {
  const { t } = useTranslation('list');
  const setup = useMemo(() => {
    const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now());
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
        3: [{ title: t('dev.tasks.offsite'), dueDate: addDays(today, 1) }],
      },
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
          <Group title={t('dev.bulkBar')}>
            <BulkBarSpecimen />
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}
