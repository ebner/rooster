import { addDays, todayIn } from '@rooster/core/dates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { Group, Section } from '../dev-ui/layout';
import { MyListView } from '../list/my-list-view';
import { fixtureMe } from '../shell/fixtures';
import { DetailPane } from './detail-pane';
import { SaveStateView } from './save-state';
import { SplitView } from './split-view';
import { createPaneControls, focusListCursor } from './tasks-screen';

const fixtureOrg = '01900000-0000-7000-8000-0000000000bb';

function LivePane({ userId }: { userId: string }) {
  const { t } = useTranslation('pane');
  const [taskId, setTaskId] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  ref.current = taskId;
  const pane = useMemo(
    () =>
      createPaneControls({
        current: () => ref.current,
        setCurrent: (id) => {
          ref.current = id;
          setTaskId(id);
        },
        go: () => undefined,
        orgSlug: 'personal',
        focusList: focusListCursor,
      }),
    [],
  );
  return (
    <div className="flex h-[640px] w-full overflow-hidden rounded-md border border-border">
      <SplitView
        label={t('label')}
        list={
          <div className="px-3 py-4">
            <MyListView orgId={fixtureOrg} userId={userId} label={t('dev.live')} pane={pane} />
          </div>
        }
        pane={
          taskId ? (
            <DetailPane
              orgId={fixtureOrg}
              orgSlug="personal"
              userId={userId}
              taskId={taskId}
              pane={pane}
              fullScreen={false}
              onFocusList={focusListCursor}
            />
          ) : null
        }
      />
    </div>
  );
}

/**
 * Kitchen-sink entry for WP 3.1–3.4: My tasks with subtasks and tags next to the detail pane
 * on an in-memory server (click a row body to open it), and the save-state labels.
 */
export function PaneSection() {
  const { t } = useTranslation('pane');
  const userId = fixtureMe.user.id;
  const setup = useMemo(() => {
    const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now());
    const transport = createFixtureTransport({
      userId,
      tags: [
        { name: 'planning', color: 'blue' },
        { name: 'work', color: 'red' },
      ],
      tasks: {
        1: [
          {
            title: 'Write Q4 plan',
            dueDate: addDays(today, 4),
            startDate: addDays(today, 2),
            tags: ['planning', 'work'],
            description: '## Goals\n\n- Ship the pane\n- [ ] Review with Anna',
            expanded: true,
            subtasks: ['Draft outline', { title: 'Collect numbers', completed: true }],
          },
          { title: 'Book dentist', dueDate: today },
        ],
      },
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.me, fixtureMe);
    queryClient.setQueryData(queryKeys.orgMembers(fixtureOrg), []);
    return { transport, queryClient };
  }, [userId]);

  return (
    <Section id="pane" title={t('dev.section')}>
      <QueryClientProvider client={setup.queryClient}>
        <ListTransportContext.Provider value={setup.transport}>
          <Group title={t('dev.live')} className="block">
            <LivePane userId={userId} />
          </Group>
          <Group title={t('save.saved')}>
            <SaveStateView status="saving" />
            <SaveStateView status="saved" />
            <SaveStateView status="offline" />
            <SaveStateView status="failed" onRetry={() => undefined} />
          </Group>
        </ListTransportContext.Provider>
      </QueryClientProvider>
    </Section>
  );
}
