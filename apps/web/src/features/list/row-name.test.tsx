import { addDays, todayIn } from '@rooster/core/dates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { setLocale } from '../../lib/i18n';
import { fixtureMe } from '../shell/fixtures';
import { MyListView } from './my-list-view';

/** 10 §5 (AC-11.3): what a screen reader says for task rows and group headers. */

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const zone = fixtureMe.user.timezone;
const today = () => todayIn(zone, Date.now());

afterEach(async () => {
  await setLocale('en');
});

async function setup(tasks: Record<number, FixtureTask[]>) {
  const transport = createFixtureTransport({ userId, tasks, timezone: zone });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <MyListView orgId={orgId} userId={userId} label="My tasks" />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
}

const dentist: FixtureTask = {
  title: 'Book dentist',
  get dueDate() {
    return addDays(today(), 1);
  },
  subtasks: [
    { title: 'Find the number', completed: true },
    { title: 'Check the calendar', completed: true },
    'Call',
    'Write it down',
    'Tell Anna',
  ],
};

test('AC-11.3 a task row reads "Book dentist, due tomorrow, not completed, 2 of 5 subtasks"', async () => {
  await setup({ 1: [dentist, { title: 'Pay rent', dueDate: addDays(today(), -2) }, 'Plain'] });
  const row = screen.getByRole('row', {
    name: 'Book dentist, due tomorrow, not completed, 2 of 5 subtasks',
  });
  // The focused title says the same: its text, then its description.
  const title = row.querySelector('[data-focus-target]') as HTMLElement;
  expect(title.textContent).toBe('Book dentist');
  expect(title.getAttribute('aria-description')).toBe(
    'due tomorrow, not completed, 2 of 5 subtasks',
  );
  expect(row.textContent).not.toContain('not completed');

  expect(
    screen.getByRole('row', { name: /^Pay rent, overdue, due .+, not completed$/ }),
  ).toBeTruthy();
  expect(screen.getByRole('row', { name: 'Plain, not completed' })).toBeTruthy();
});

test('AC-11.3 a group header reads "Today, group, 3 tasks, expanded"', async () => {
  await setup({ 1: ['One', 'Two', 'Three'] });
  const header = screen.getByRole('row', { name: 'Today, group, 3 tasks' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  const name = header.querySelector('[data-focus-target]') as HTMLElement;
  expect(name.getAttribute('aria-description')).toBe('group, 3 tasks, expanded');
});

test('the names are Swedish in Swedish', async () => {
  await setLocale('sv');
  await setup({ 1: [dentist] });
  expect(
    screen.getByRole('row', {
      name: 'Book dentist, förfaller imorgon, inte klar, 2 av 5 deluppgifter',
    }),
  ).toBeTruthy();
});
