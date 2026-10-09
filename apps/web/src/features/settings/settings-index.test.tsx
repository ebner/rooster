import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MobileHeader } from '../shell/mobile-header';
import { SettingsIndex } from './settings-index';

describe('Settings on phones: the index and a drilled-in section', () => {
  test('the index is a list of links, one per section, each with what it holds', () => {
    render(<SettingsIndex />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/profile',
      '/settings/behaviour',
      '/settings/notifications',
      '/settings/security',
      '/settings/data',
    ]);
    expect(within(nav).getAllByRole('listitem')).toHaveLength(5);
    expect(links[2]?.textContent).toBe('NotificationsIn app, push, email and the daily digest');
  });

  test('a section header has "‹ Settings" back to the index and focuses its title', () => {
    render(
      <MobileHeader
        title="Notifications"
        back={{ href: '/settings', label: 'Settings' }}
        syncPill={null}
      />,
    );
    const back = screen.getByRole('link', { name: 'Back to Settings' });
    expect(back.getAttribute('href')).toBe('/settings');
    expect(back.textContent).toBe('Settings');
    const title = screen.getByRole('heading', { level: 1, name: 'Notifications' });
    expect(document.activeElement).toBe(title);
  });

  test('without `back` the header keeps the mark and moves no focus', () => {
    render(<MobileHeader title="Settings" syncPill={null} />);
    expect(screen.queryByTestId('header-back')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
