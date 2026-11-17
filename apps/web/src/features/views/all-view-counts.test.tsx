import { addDays, todayIn } from '@rooster/core/dates';
import type { ListState } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test } from 'vitest';
import { ListTransportContext, myListKey } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import type { Me } from '../../data/types';
import { fixtureMe } from '../shell/fixtures';
import { LiveViewCounts, useAllViewCounts } from './view-counts';

const userId = fixtureMe.user.id;
const today = todayIn(fixtureMe.user.timezone, Date.now());

/** Shows the summed badges and how often it rendered. */
function Probe() {
  const counts = useAllViewCounts();
  const renders = useRef(0);
  renders.current += 1;
  return (
    <>
      <output data-testid="counts">{counts ? JSON.stringify(counts) : 'none'}</output>
      <output data-testid="renders">{renders.current}</output>
    </>
  );
}

function setup(me: Me = fixtureMe) {
  // Every org gets the same seed: Inbox due today, Prio two days overdue, Today in 3 days.
  const transport = createFixtureTransport({
    userId,
    timezone: fixtureMe.user.timezone,
    tasks: {
      0: [{ title: 'Due today', dueDate: today }],
      1: [{ title: 'Later', dueDate: addDays(today, 3) }, { title: 'Undated' }],
      2: [{ title: 'Late', dueDate: addDays(today, -2) }],
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, me);
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <LiveViewCounts>
          <Probe />
        </LiveViewCounts>
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const shown = () => {
  const text = screen.getByTestId('counts').textContent ?? '';
  return text === 'none' ? null : (JSON.parse(text) as Record<string, number>);
};

describe('useAllViewCounts (ADR 0073 A5)', () => {
  test('outside the app there are no counts', () => {
    render(<Probe />);
    expect(shown()).toBeNull();
  });

  test('sums Today, Next 7 days and Overdue over every org’s cached list', async () => {
    setup();
    // Three orgs, each: today 2 (due today and overdue), week 2, overdue 1.
    await waitFor(() => expect(shown()).toEqual({ today: 6, week: 6, overdue: 3 }));
  });

  test('a completed task in one org lowers the sums; other changes do not re-render', async () => {
    const { queryClient } = setup();
    await waitFor(() => expect(shown()).toEqual({ today: 6, week: 6, overdue: 3 }));
    const company = fixtureMe.orgs[1]?.id ?? '';
    const state = queryClient.getQueryData<ListState>(myListKey(company));
    if (!state) throw new Error('no list');
    const late = Object.values(state.tasks).find((t) => t.title === 'Late');
    const undated = Object.values(state.tasks).find((t) => t.title === 'Undated');
    if (!late || !undated) throw new Error('no tasks');

    const renders = Number(screen.getByTestId('renders').textContent);
    // A rename changes the list but no count: the badges stay as they are.
    await act(async () => {
      queryClient.setQueryData<ListState>(myListKey(company), {
        ...state,
        tasks: { ...state.tasks, [undated.id]: { ...undated, title: 'Renamed' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(Number(screen.getByTestId('renders').textContent)).toBe(renders);

    act(() => {
      queryClient.setQueryData<ListState>(myListKey(company), (current) =>
        current
          ? {
              ...current,
              tasks: { ...current.tasks, [late.id]: { ...late, completedAt: Date.now() } },
            }
          : current,
      );
    });
    await waitFor(() => expect(shown()).toEqual({ today: 5, week: 6, overdue: 2 }));
  });

  test('only the orgs the user is in count', async () => {
    setup({ ...fixtureMe, orgs: fixtureMe.orgs.slice(0, 2) });
    await waitFor(() => expect(shown()).toEqual({ today: 4, week: 4, overdue: 2 }));
  });
});
