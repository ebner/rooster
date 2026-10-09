import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { fixtureMe } from '../shell/fixtures';
import { MyListView } from './my-list-view';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';

test('rows with a description show the indicator, before the subtask counter', async () => {
  const transport = createFixtureTransport({
    userId,
    tasks: {
      1: [
        { title: 'Notes', description: 'Some notes', subtasks: ['Child'] },
        { title: 'Blank', description: '  ' },
        'Plain',
      ],
    },
  });
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
  const row = (title: string) =>
    screen
      .getAllByTestId('task-row')
      .find((r) => r.querySelector('[data-focus-target]')?.textContent === title) as HTMLElement;

  const notes = within(row('Notes'));
  const indicator = notes.getByTestId('description-indicator');
  expect(indicator.getAttribute('title')).toBe('Has description');
  expect(within(indicator).getByText('Has description').className).toContain('sr-only');
  const counter = notes.getByTestId('subtask-counter');
  expect(
    indicator.compareDocumentPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(row('Blank')).queryByTestId('description-indicator')).toBeNull();
  expect(within(row('Plain')).queryByTestId('description-indicator')).toBeNull();
});
