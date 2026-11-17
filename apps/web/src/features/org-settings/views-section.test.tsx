import type { SavedView } from '@rooster/core/schemas';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Org } from '../../data/types';
import { fixtureMe } from '../shell/fixtures';
import { sampleSavedView } from '../shell/saved-views-kitchen';
import { ViewsSection, type ViewsSectionProps } from './views-section';

const [personal, company] = fixtureMe.orgs as [Org, Org, Org];
const juniper = sampleSavedView(1, 'Juniper', {
  tags: ['0192f5d0-7a1e-7c3a-9f10-0000000000f1'],
  openCount: 7,
});
const mine = sampleSavedView(2, 'Mine this week', { shared: false, openCount: 1 });
const old = sampleSavedView(3, 'Website relaunch', { archivedAt: 1 });

function renderSection(overrides: Partial<ViewsSectionProps> = {}) {
  const handlers = {
    onArchive: vi.fn<(view: SavedView) => unknown>(),
    onRestore: vi.fn<(view: SavedView) => unknown>(),
    onDelete: vi.fn<(view: SavedView) => unknown>(),
  };
  render(
    <ViewsSection
      org={company}
      views={[juniper, mine]}
      archived={[old]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const row = (name: string) =>
  screen.getAllByTestId('view-settings-row').find((r) => r.dataset.view === name) as HTMLElement;

describe('Org settings → Views (ADR 0073 B10, B13)', () => {
  test('the live views link to themselves; the archived ones are listed apart', () => {
    renderSection();
    const live = screen.getByRole('list', { name: 'In the sidebar' });
    expect(
      within(live)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual([`/o/northwind/v/${juniper.id}`, `/o/northwind/v/${mine.id}`]);
    expect(within(live).getByText('Shared · Project view · 7 open')).toBeTruthy();
    expect(within(live).getByText('Only you · 1 open')).toBeTruthy();
    const archived = screen.getByRole('list', { name: 'Archived' });
    expect(within(archived).queryByRole('link')).toBeNull();
    expect(within(archived).getByText('Website relaunch')).toBeTruthy();
  });

  test('B13: a shared org says a view is no access control; a personal one has no sharing', () => {
    renderSection();
    expect(
      screen.getByText(
        'Everyone in Northwind can see these tasks anyway; a view only gathers them.',
      ),
    ).toBeTruthy();
  });

  test('a personal org shows neither the note nor Shared / Only you', () => {
    renderSection({ org: personal, views: [{ ...mine, orgId: personal.id }], archived: [] });
    expect(screen.queryByText(/can see these tasks anyway/)).toBeNull();
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText('No archived views.')).toBeTruthy();
  });

  test('Archive and Restore act at once', () => {
    const { onArchive, onRestore } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Juniper' }));
    expect(onArchive).toHaveBeenCalledWith(juniper);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Website relaunch' }));
    expect(onRestore).toHaveBeenCalledWith(old);
  });

  test('Delete asks inline first; Cancel keeps the view', async () => {
    const { onDelete } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Juniper' }));
    const confirm = within(row('Juniper')).getByRole('group', { name: 'Delete view' });
    expect(
      within(confirm).getByText(
        'Delete the view “Juniper” for everyone who sees it? Its tasks and tags stay as they are.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(within(row('Juniper')).queryByRole('group')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Mine this week' }));
    const own = within(row('Mine this week')).getByRole('group', { name: 'Delete view' });
    expect(within(own).getByText(/^Delete the view “Mine this week”\?/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(own).getByRole('button', { name: 'Delete view' }));
    });
    expect(onDelete).toHaveBeenCalledWith(mine);
  });

  test('empty lists say so', () => {
    renderSection({ views: [], archived: [] });
    expect(
      screen.getByText('No views yet. Create one with “New view” in the sidebar.'),
    ).toBeTruthy();
    expect(screen.getByText('No archived views.')).toBeTruthy();
  });
});
