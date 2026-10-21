import { groupActivity } from '@rooster/core/activity';
import { formatMention } from '@rooster/core/mentions';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useKeymap } from '../../use-keymap';
import { sampleDateContext } from '../dates/fixtures';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { Sidebar } from '../shell/sidebar';
import { ActivityFeed } from './activity-feed';
import { CommentBody } from './comment-body';
import { CommentComposer, type CommentComposerHandle } from './comment-composer';
import { fixtureCandidates, fixtureFeed, fixtureNotifications, fixturePeople } from './fixtures';
import { StaticInboxNav } from './inbox-nav';
import { InboxPage, type InboxPageProps } from './inbox-page';

function KeymapRoot() {
  useKeymap();
  return null;
}

describe('CommentBody (FR-COL-3)', () => {
  test('renders Markdown-light, mention chips and safe links; never raw HTML', () => {
    const body = `Hi ${formatMention('Anna Lindqvist', fixtureIds.anna)} **now** <b>x</b> [doc](https://example.com) [bad](javascript:alert(1))`;
    const { container } = render(<CommentBody body={body} viewerId={fixtureIds.anna} />);
    const chip = container.querySelector(`[data-mention="${fixtureIds.anna}"]`);
    expect(chip?.textContent).toBe('@Anna Lindqvist');
    expect(container.querySelector('strong')?.textContent).toBe('now');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('a mention shows the member’s current name', () => {
    const body = formatMention('Old name', fixtureIds.anna);
    render(<CommentBody body={body} nameOf={() => 'Anna Lindqvist'} />);
    expect(screen.getByText('@Anna Lindqvist')).toBeTruthy();
  });
});

describe('ActivityFeed via (06 §1, 11 §2.3)', () => {
  test('a change made through an OAuth app reads "via an app"', () => {
    const dateCtx = sampleDateContext('en');
    const feed = fixtureFeed(dateCtx.nowMs).map((item) =>
      item.kind === 'activity' && item.activity.via === 'cli'
        ? { ...item, activity: { ...item.activity, via: 'oauth' as const } }
        : item,
    );
    render(
      <ActivityFeed
        entries={groupActivity(feed)}
        viewerId={fixtureIds.jannik}
        person={(id) => fixturePeople[id]}
        pending={new Set()}
        now={dateCtx.nowMs}
        locale="en"
        dateCtx={dateCtx}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/via an app/)).toBeTruthy();
    expect(screen.queryByText(/via the CLI/)).toBeNull();
  });
});

describe('CommentComposer (02 §9.2 item 8)', () => {
  function Harness({ onPost, taskId = 't1' }: { onPost: (body: string) => void; taskId?: string }) {
    const ref = useRef<CommentComposerHandle>(null);
    return (
      <>
        <CommentComposer ref={ref} taskId={taskId} candidates={fixtureCandidates} onPost={onPost} />
        <button type="button" onClick={() => ref.current?.submit()}>
          submit
        </button>
      </>
    );
  }
  const field = () => screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement;
  const type = (value: string) =>
    fireEvent.change(field(), { target: { value, selectionStart: value.length } });

  test('@ offers members; Enter inserts the stored mention', () => {
    const onPost = vi.fn();
    render(<Harness onPost={onPost} />);
    type('Hi @an');
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')[0]?.textContent).toContain('Anna Lindqvist');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe(`Hi ${formatMention('Anna Lindqvist', fixtureIds.anna)} `);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onPost).not.toHaveBeenCalled();
  });

  test('↓ moves the choice; Esc closes the suggestions without leaving', () => {
    const onEscape = vi.fn();
    render(
      <CommentComposer
        taskId="t2"
        candidates={fixtureCandidates}
        onPost={() => undefined}
        onEscape={onEscape}
      />,
    );
    type('@');
    const options = () => screen.getAllByRole('option');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  test('Ctrl+Enter posts the trimmed body and clears the draft', () => {
    const onPost = vi.fn();
    render(<Harness onPost={onPost} taskId="t3" />);
    type('  Looks good  ');
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    expect(onPost).toHaveBeenCalledWith('Looks good');
    expect(field().value).toBe('');
    // Empty drafts are not posted.
    fireEvent.click(screen.getByText('submit'));
    expect(onPost).toHaveBeenCalledOnce();
  });

  test('the draft survives switching tasks', () => {
    const { unmount } = render(<Harness onPost={() => undefined} taskId="t4" />);
    type('half a thought');
    unmount();
    const other = render(<Harness onPost={() => undefined} taskId="t5" />);
    expect(field().value).toBe('');
    other.unmount();
    render(<Harness onPost={() => undefined} taskId="t4" />);
    expect(field().value).toBe('half a thought');
  });
});

describe('InboxPage (FR-NOT-1)', () => {
  const ctx = sampleDateContext('en');
  const items = fixtureNotifications(ctx.nowMs);
  function renderInbox(overrides: Partial<InboxPageProps> = {}) {
    const props: InboxPageProps = {
      items,
      unreadCount: 2,
      filter: 'all',
      onFilterChange: vi.fn(),
      hasMore: false,
      isLoadingMore: false,
      onLoadMore: vi.fn(),
      orgName: () => 'Brightwater',
      now: ctx.nowMs,
      locale: 'en',
      dateCtx: ctx,
      onOpen: vi.fn(),
      onToggleRead: vi.fn(),
      onMarkAllRead: vi.fn(),
      ...overrides,
    };
    render(
      <>
        <KeymapRoot />
        <InboxPage {...props} />
      </>,
    );
    return props;
  }

  test('renders a sentence per type, unread first-class', () => {
    renderInbox();
    const rows = screen.getAllByTestId('notification');
    expect(rows).toHaveLength(items.length);
    expect(rows[0]?.textContent).toContain('Anna Lindqvist mentioned you');
    expect(rows[0]?.hasAttribute('data-unread')).toBe(true);
    expect(rows[2]?.textContent).toContain('changed the due date of your task to');
    expect(rows[5]?.textContent).toContain('joined Brightwater');
    expect(rows[2]?.hasAttribute('data-unread')).toBe(false);
  });

  test('comment excerpts show as plain text, without their Markdown', () => {
    const first = items[0] as (typeof items)[number];
    renderInbox({
      items: [
        {
          ...first,
          data: {
            ...first.data,
            excerpt: 'Call **Bob** about [the plan](https://example.com) — `now`',
          },
        },
      ],
    });
    const row = screen.getByTestId('notification');
    expect(row.textContent).toContain('Call Bob about the plan — now');
    expect(row.textContent).not.toContain('**');
  });

  test('P10: a reminder has no actor, shows the due moment and marks a late one', () => {
    renderInbox();
    const rows = screen.getAllByTestId('notification');
    const onTime = rows[6] as HTMLElement;
    const late = rows[7] as HTMLElement;
    expect(onTime.textContent).toContain('Reminder · due Mon 2 PM');
    expect(onTime.textContent).toContain('Write Q4 plan');
    expect(onTime.textContent).not.toContain('Rooster');
    expect(within(onTime).queryByTestId('reminder-late')).toBeNull();
    expect(within(late).getByTestId('reminder-late').textContent).toContain('sent late');
  });

  test('J/↓ move, Enter opens, U toggles read, Shift+U marks all read', () => {
    const props = renderInbox();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'j' });
    });
    const first = document.activeElement as HTMLElement;
    expect(first.closest('[data-notification-id]')?.getAttribute('data-notification-id')).toBe(
      items[0]?.id,
    );
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = document.activeElement as HTMLElement;
    expect(second.closest('[data-notification-id]')?.getAttribute('data-notification-id')).toBe(
      items[1]?.id,
    );
    fireEvent.keyDown(second, { key: 'u' });
    expect(props.onToggleRead).toHaveBeenCalledWith(items[1]);
    fireEvent.keyDown(second, { key: 'U', shiftKey: true });
    expect(props.onMarkAllRead).toHaveBeenCalledOnce();
    fireEvent.click(second);
    expect(props.onOpen).toHaveBeenCalledWith(items[1]);
  });

  test('empty states per filter', () => {
    renderInbox({ items: [], unreadCount: 0, filter: 'unread' });
    expect(screen.getByTestId('inbox-empty').textContent).toContain('all caught up');
    expect(
      (screen.getByTestId('mark-all-read') as HTMLButtonElement).hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('Sidebar Inbox (02 §2)', () => {
  const props = {
    user: fixtureMe.user,
    orgs: fixtureMe.orgs,
    locale: 'en' as const,
    onReorder: () => undefined,
    onToggleOrgCollapsed: () => undefined,
    onCreateOrg: () => undefined,
    onLocaleChange: () => undefined,
    onSignOut: () => undefined,
  };

  test('shows the unread count under Search, and a dot in the rail', () => {
    const { unmount } = render(
      <StaticInboxNav state={{ unread: 3, active: true }}>
        <Sidebar {...props} collapsed={false} />
      </StaticInboxNav>,
    );
    const item = screen.getByTestId('sidebar-inbox');
    expect(item.getAttribute('href')).toBe('/inbox');
    expect(item.getAttribute('aria-current')).toBe('page');
    expect(item.textContent).toContain('3 unread');
    unmount();
    render(
      <StaticInboxNav state={{ unread: 3, active: false }}>
        <Sidebar {...props} collapsed />
      </StaticInboxNav>,
    );
    const rail = screen.getByTestId('sidebar-inbox');
    expect(rail.getAttribute('aria-label')).toBe('Inbox · 3 unread');
    expect(within(rail).getByTestId('sidebar-dot')).toBeTruthy();
  });

  test('no badge without unread notifications', () => {
    render(
      <StaticInboxNav state={{ unread: 0, active: false }}>
        <Sidebar {...props} collapsed={false} />
      </StaticInboxNav>,
    );
    expect(screen.getByTestId('sidebar-inbox').textContent).toBe('Inbox');
  });
});

describe('Settings → Notifications', () => {
  test('the matrix rows are the preference matrix’s event types', async () => {
    const { NOTIFICATION_EVENT_TYPES } = await import('@rooster/core/notification-prefs');
    const { notificationTypes } = await import('../settings/notifications-page');
    expect([...notificationTypes]).toEqual([...NOTIFICATION_EVENT_TYPES]);
  });
});
