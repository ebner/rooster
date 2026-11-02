import type { IcalFeed, IcalFeedCreate } from '@rooster/core/schemas';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DisplayPrefs } from '../../lib/format';
import { AvatarField } from './avatar-field';
import { CalendarFeedsSection, type CalendarFeedsSectionProps, webcalUrl } from './calendar-feeds';

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 10, 10);
const orgs = [
  { id: '0192f5d0-7a1e-7c3a-9f10-000000000001', name: 'Personal' },
  { id: '0192f5d0-7a1e-7c3a-9f10-000000000002', name: 'Brightwater' },
];
const feeds: IcalFeed[] = [
  { id: 'feed-all', orgId: null, createdAt: now - 3 * 86_400_000, lastUsedAt: now - 5 * 60_000 },
  { id: 'feed-meta', orgId: orgs[1]?.id ?? null, createdAt: now - 86_400_000, lastUsedAt: null },
];
const url = 'https://rooster.example.com/ical/rcal_secret.ics';

function section(props: Partial<CalendarFeedsSectionProps> = {}) {
  const onCreate = vi.fn(async (input: IcalFeedCreate) => ({
    feed: { id: 'feed-new', orgId: input.orgId ?? null, createdAt: now, lastUsedAt: null },
    url,
  }));
  const onRevoke = vi.fn(async () => undefined);
  render(
    <CalendarFeedsSection
      feeds={feeds}
      orgs={orgs}
      prefs={prefs}
      now={now}
      online
      onCreate={onCreate}
      onRevoke={onRevoke}
      {...props}
    />,
  );
  return { onCreate, onRevoke };
}

describe('Settings → Calendar feed (FR-CAL)', () => {
  test('lists the feeds, newest first, with their scope, created and last fetched', () => {
    section();
    const rows = screen.getAllByTestId('calendar-feed');
    expect(rows.map((r) => r.textContent?.split('Created')[0])).toEqual([
      'Brightwater',
      'All organisations',
    ]);
    expect(rows[0]?.textContent).toContain('Created Yesterday · Not fetched yet');
    expect(rows[1]?.textContent).toContain('Last fetched 5 minutes ago');
  });

  test('a new feed for all orgs shows its secret link once, with copy and subscribe', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { onCreate } = section();
    fireEvent.click(screen.getByTestId('new-feed'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-feed'));
    });
    expect(onCreate).toHaveBeenCalledWith({});
    const reveal = screen.getByTestId('feed-reveal');
    expect(reveal.textContent).toContain('Your feed for All organisations');
    expect(reveal.textContent).toContain('Keep this link secret');
    expect((screen.getByTestId('feed-url') as HTMLInputElement).value).toBe(url);
    expect(screen.getByTestId('subscribe-feed').getAttribute('href')).toBe(
      'webcal://rooster.example.com/ical/rcal_secret.ics',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-feed'));
    });
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByTestId('copy-feed').textContent).toBe('Copied');
    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('feed-reveal')).toBeNull();
  });

  test('revoke asks inline; Escape cancels', async () => {
    const { onRevoke } = section();
    const [row] = screen.getAllByTestId('calendar-feed');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Revoke Brightwater' }));
    const confirm = within(row as HTMLElement).getByTestId('confirm-feed');
    expect(row?.textContent).toContain('Revoke the feed for Brightwater?');
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(within(row as HTMLElement).queryByTestId('confirm-feed')).toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Revoke Brightwater' }));
    await act(async () => {
      fireEvent.click(within(row as HTMLElement).getByTestId('confirm-feed'));
    });
    expect(onRevoke).toHaveBeenCalledWith('feed-meta');
  });

  test('a new link replaces the feed for the same org and shows the new URL', async () => {
    const { onCreate } = section();
    const [row] = screen.getAllByTestId('calendar-feed');
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'New link for Brightwater' }),
    );
    expect(row?.textContent).toContain('The current link stops working at once');
    await act(async () => {
      fireEvent.click(within(row as HTMLElement).getByTestId('confirm-feed'));
    });
    expect(onCreate).toHaveBeenCalledWith({ orgId: orgs[1]?.id, replaces: 'feed-meta' });
    expect(screen.getByTestId('feed-reveal')).toBeTruthy();
  });

  test('at ten feeds, no more can be created', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      orgId: null,
      createdAt: now - i,
      lastUsedAt: null,
    }));
    section({ feeds: many });
    expect(screen.getByTestId('new-feed').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/the most you can have/)).toBeTruthy();
  });

  test('offline: a note, and nothing can change', () => {
    section({ online: false });
    expect(screen.getByText(/You’re offline/)).toBeTruthy();
    expect(screen.getByTestId('new-feed').hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByTestId('revoke-feed')[0]?.hasAttribute('disabled')).toBe(true);
  });

  test('a feed URL becomes a webcal subscription', () => {
    expect(webcalUrl('https://a.example/ical/x.ics')).toBe('webcal://a.example/ical/x.ics');
    expect(webcalUrl('http://localhost:5173/ical/x.ics')).toBe(
      'webcal://localhost:5173/ical/x.ics',
    );
  });
});

describe('Profile → picture (FR-SET-1)', () => {
  test('uploads the chosen image; remove only for an uploaded one', () => {
    const onUpload = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <AvatarField
        uploaded={false}
        pending={null}
        error={null}
        online
        onUpload={onUpload}
        onRemove={onRemove}
      />,
    );
    expect(screen.queryByTestId('avatar-remove')).toBeNull();
    expect(screen.getByTestId('avatar-field').textContent).toContain('from your sign-in provider');
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-input'), { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith(file);
    rerender(
      <AvatarField
        uploaded
        pending={null}
        error="size"
        online
        onUpload={onUpload}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByTestId('avatar-upload').textContent).toBe('Change picture');
    expect(screen.getByRole('alert').textContent).toBe('That picture is larger than 2 MB.');
    fireEvent.click(screen.getByTestId('avatar-remove'));
    expect(onRemove).toHaveBeenCalled();
  });
});
