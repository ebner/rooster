import { describe, expect, test } from 'vitest';
import { scrollResets } from './scroll-reset';

describe('scroll resets on navigation', () => {
  test('another page, section or guide page starts at the top', () => {
    expect(scrollResets('/admin', '/settings/profile', 'my').page).toBe(true);
    expect(scrollResets('/settings/profile', '/settings/data', 'my').page).toBe(true);
    expect(scrollResets('/help/my-tasks', '/help/reminders', 'my').page).toBe(true);
    expect(scrollResets('/o/acme/my', '/o/acme/today', 'my').page).toBe(true);
    expect(scrollResets('/o/acme/my', '/o/other/my', 'my').page).toBe(true);
  });

  test('the list keeps its place while the pane opens, follows and closes over it', () => {
    expect(scrollResets('/o/acme/today', '/o/acme/t/a', 'today')).toEqual({
      page: false,
      task: true,
    });
    expect(scrollResets('/o/acme/t/a', '/o/acme/t/b', 'today')).toEqual({
      page: false,
      task: true,
    });
    expect(scrollResets('/o/acme/t/b', '/o/acme/today', 'today')).toEqual({
      page: false,
      task: true,
    });
    // The pane's sidebar link to another view does change the page.
    expect(scrollResets('/o/acme/t/b', '/o/acme/week', 'today').page).toBe(true);
  });

  test('All organisations: the pane keeps the list’s place over the last All view', () => {
    expect(scrollResets('/all/week', '/all/t/a', 'my', 'week')).toEqual({
      page: false,
      task: true,
    });
    expect(scrollResets('/all/t/a', '/all/t/b', 'my', 'week')).toEqual({
      page: false,
      task: true,
    });
    expect(scrollResets('/all/t/b', '/all/week', 'my', 'week').page).toBe(false);
    expect(scrollResets('/all/today', '/all/week', 'my', 'today').page).toBe(true);
    expect(scrollResets('/all/today', '/o/acme/today', 'today', 'today').page).toBe(true);
  });

  test('the same page (a search or trailing slash) keeps everything', () => {
    expect(scrollResets('/settings/profile', '/settings/profile/', 'my')).toEqual({
      page: false,
      task: false,
    });
  });
});
