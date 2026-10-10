import { defaultPrefEnabled, NOTIFICATION_PREF_CELLS } from '@rooster/core/notification-prefs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { fixturePushDevices } from './fixtures';
import { NotificationsPage, type NotificationsPageProps } from './notifications-page';
import {
  PushDeviceSection,
  type PushDeviceSectionProps,
  pushDeviceState,
} from './push-device-section';

const prefs = NOTIFICATION_PREF_CELLS.map(({ type, channel }) => ({
  type,
  channel,
  enabled: defaultPrefEnabled(type, channel),
}));

function renderPage(overrides: Partial<NotificationsPageProps> = {}) {
  const props: NotificationsPageProps = {
    prefs,
    channels: { push: true, email: true },
    onChange: vi.fn(),
    delivery: {
      value: { reminderTime: '08:00', digestTime: '07:00', emailMode: 'batch' },
      locale: 'en',
      timeFormat: '12h',
      onChange: vi.fn(),
    },
    push: <p>push section</p>,
    layout: 'table',
    ...overrides,
  };
  render(<NotificationsPage {...props} />);
  return props;
}

describe('Settings → Notifications', () => {
  test('the full matrix: three columns, the digest only as email, the reminder only as push', () => {
    renderPage();
    const table = screen.getByTestId('notification-prefs');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Event', 'In app', 'Push', 'Email']);
    expect(screen.getAllByRole('switch')).toHaveLength(NOTIFICATION_PREF_CELLS.length);
    expect(screen.getByRole('switch', { name: 'Daily digest: Email' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Daily digest: Push' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Due reminder: Push' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Due reminder: In app' })).toBeNull();
    // Defaults (ADR 0033): email only for assignments and mentions.
    const assignedEmail = screen.getByRole('switch', { name: 'A task is assigned to me: Email' });
    expect((assignedEmail as HTMLInputElement).checked).toBe(true);
    const commentEmail = screen.getByRole('switch', {
      name: 'Someone comments on a task I follow: Email',
    });
    expect((commentEmail as HTMLInputElement).checked).toBe(false);
  });

  test('AC-7.3 without SMTP there is no email column, digest row, digest time or email mode', () => {
    renderPage({ channels: { push: true, email: false } });
    const headers = within(screen.getByTestId('notification-prefs'))
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(['Event', 'In app', 'Push']);
    expect(screen.queryByText('Daily digest')).toBeNull();
    expect(screen.queryByText('Daily digest time')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Notification emails' })).toBeNull();
    expect(screen.getByText('Due reminder time')).toBeTruthy();
  });

  test('without push there is no push column, reminder row or push section', () => {
    renderPage({ channels: { push: false, email: false } });
    expect(screen.queryByText('Due reminder')).toBeNull();
    expect(screen.queryByText('push section')).toBeNull();
    // Task reminders still reach the inbox: only the all-day reminder time remains (P10).
    expect(screen.getByRole('heading', { name: 'Timing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /All-day reminder time/ })).toBeTruthy();
    expect(screen.queryByText('Due reminder time')).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(7);
  });

  test('a switch reports its type and channel', () => {
    const props = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Someone mentions me: Push' }));
    expect(props.onChange).toHaveBeenCalledWith('mention', false, 'push');
  });

  test('the phone layout stacks the channels under each event', () => {
    renderPage({ layout: 'stacked' });
    const list = screen.getByTestId('notification-prefs');
    expect(list.tagName).toBe('UL');
    const digest = within(list).getByText('Daily digest').closest('li') as HTMLElement;
    expect(within(digest).getAllByRole('switch')).toHaveLength(1);
    expect(screen.getAllByRole('switch')).toHaveLength(NOTIFICATION_PREF_CELLS.length);
  });

  test('times show in the user’s time format; the email mode saves', () => {
    const props = renderPage();
    expect(screen.getByRole('button', { name: /Due reminder time/ }).textContent).toContain('8 AM');
    expect(screen.getByRole('button', { name: /Daily digest time/ }).textContent).toContain('7 AM');
    fireEvent.click(screen.getByRole('radio', { name: 'Immediately' }));
    expect(props.delivery?.onChange).toHaveBeenCalledWith({ emailMode: 'immediate' });
  });

  test('P10: the all-day reminder time defaults to 09:00 and saves', () => {
    const props = renderPage();
    const field = screen.getByRole('button', { name: /All-day reminder time/ });
    expect(field.textContent).toContain('9 AM');
    fireEvent.click(field);
    fireEvent.click(screen.getByRole('option', { name: '8:30 AM' }));
    expect(props.delivery?.onChange).toHaveBeenCalledWith({ allDayReminderTime: '08:30' });
  });
});

function renderPush(overrides: Partial<PushDeviceSectionProps> = {}) {
  const props: PushDeviceSectionProps = {
    state: 'off',
    devices: fixturePushDevices,
    currentDeviceId: 'push-laptop',
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onTest: vi.fn(),
    onRemove: vi.fn(),
    onShowInstallSteps: vi.fn(),
    locale: 'en',
    now: Date.now(),
    ...overrides,
  };
  render(<PushDeviceSection {...props} />);
  return props;
}

describe('Push on this device', () => {
  test('off: the button asks for permission; devices list with test and remove', () => {
    const props = renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on push for this device' }));
    expect(props.onEnable).toHaveBeenCalled();
    const devices = screen.getByTestId('push-devices');
    expect(within(devices).getByText('Chrome on Linux')).toBeTruthy();
    expect(within(devices).getByText('This device')).toBeTruthy();
    expect(within(devices).getByText('Nothing delivered yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test notification to iOS' }));
    expect(props.onTest).toHaveBeenCalledWith('push-phone');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Firefox on Windows' }));
    expect(props.onRemove).toHaveBeenCalledWith('push-firefox');
  });

  test('on: turn off', () => {
    const props = renderPush({ state: 'on' });
    expect(screen.getByText('Push is on for this device.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(props.onDisable).toHaveBeenCalled();
  });

  test('blocked, the iOS hint and unsupported never offer the button', () => {
    renderPush({ state: 'denied' });
    expect(screen.getByText('Notifications are blocked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on push for this device' })).toBeNull();
  });

  test('iOS Safari: install first, with the steps sheet', () => {
    const props = renderPush({ state: 'ios-install' });
    expect(screen.getByText(/push works only in the installed app/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
    expect(props.onShowInstallSteps).toHaveBeenCalled();
  });

  test('unsupported', () => {
    renderPush({ state: 'unsupported', devices: [] });
    expect(screen.getByText('Push notifications aren’t available in this browser.')).toBeTruthy();
    expect(screen.getByText('No devices yet.')).toBeTruthy();
  });
});

describe('this device’s push state', () => {
  const base = {
    support: 'available' as const,
    permission: 'granted' as const,
    failed: false,
    subscribed: true,
    known: true,
  };
  test('on needs the subscription, the server record and the permission', () => {
    expect(pushDeviceState(base)).toBe('on');
    expect(pushDeviceState({ ...base, known: false })).toBe('off');
    expect(pushDeviceState({ ...base, subscribed: false })).toBe('off');
    expect(pushDeviceState({ ...base, permission: 'default' })).toBe('off');
  });
  test('blocked, iOS, unsupported and loading win in that order', () => {
    expect(pushDeviceState({ ...base, support: 'ios-install' })).toBe('ios-install');
    expect(pushDeviceState({ ...base, permission: 'denied' })).toBe('denied');
    expect(pushDeviceState({ ...base, failed: true })).toBe('unsupported');
    expect(pushDeviceState({ ...base, subscribed: undefined })).toBe('loading');
  });
});
