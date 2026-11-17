import { beforeEach, describe, expect, test } from 'vitest';
import { listViewOf, rememberListView, useLastListView, viewOfPath } from './last-view';

/** 02 §2 and ADR 0073 B: the list view under the pane. */

beforeEach(() => useLastListView.setState({ view: 'my', org: null }));

describe('listViewOf', () => {
  test('a view stays under the pane of its own org', () => {
    rememberListView('v:abc', 'kestrel');
    expect(listViewOf('/o/kestrel/t/t1', 'v:abc')).toBe('v:abc');
  });

  test('another org’s pane (a task opened from the palette or the Inbox) shows My tasks', () => {
    rememberListView('v:abc', 'kestrel');
    expect(listViewOf('/o/personal/t/t1', 'v:abc')).toBe('my');
  });

  test('built-in views carry over to any org; own paths answer for themselves', () => {
    rememberListView('today', 'kestrel');
    expect(listViewOf('/o/personal/t/t1', 'today')).toBe('today');
    expect(viewOfPath('/o/kestrel/v/abc')).toBe('v:abc');
    expect(viewOfPath('/o/kestrel/v/new')).toBeNull();
  });
});
