import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { userStorageKey } from '../../lib/user-storage';
import { clearToasts } from '../../ui/toast';
import { useWhatsNewNotice, whatsNewHref, whatsNewStep } from './whats-new';

const env = vi.hoisted(() => ({
  version: '1.5.3',
  startOwner: null as string | null,
  html: '<h2 id="153">1.5.3</h2>',
  toast: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../data/sync/build-info', () => ({
  buildInfo: {
    get version() {
      return env.version;
    },
  },
}));
vi.mock('../../data/sync/engine', () => ({ syncEngine: () => ({ startOwner: env.startOwner }) }));
vi.mock('./guide-content', () => ({
  loadGuide: async () => [{ slug: 'whats-new', title: '', lang: 'en', html: env.html }],
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => env.navigate }));
vi.mock('../../ui/toast', async (actual) => ({
  ...(await actual<typeof import('../../ui/toast')>()),
  toast: env.toast,
}));

const seenKey = userStorageKey('u1', 'whatsNew.seen');

async function load() {
  const hook = renderHook(() => useWhatsNewNotice('u1', 'en'));
  await act(async () => {});
  hook.unmount();
}

describe("What's new (ADR 0057)", () => {
  beforeEach(() => {
    localStorage.clear();
    env.version = '1.5.3';
    env.startOwner = null;
    env.html = '<h2 id="153">1.5.3</h2>';
  });
  afterEach(() => {
    env.toast.mockReset();
    env.navigate.mockReset();
    clearToasts();
  });

  test('the decision: a first visit is recorded, a newer version offered, a downgrade recorded', () => {
    expect(whatsNewStep(null, '1.5.3', false)).toBe('record');
    // An account that used this browser before the notes existed is told once.
    expect(whatsNewStep(null, '1.5.3', true)).toBe('notify');
    expect(whatsNewStep('1.5.2', '1.5.3', true)).toBe('notify');
    expect(whatsNewStep('1.5.9', '1.6.0', false)).toBe('notify');
    expect(whatsNewStep('1.5.3', '1.5.3', true)).toBe('none');
    expect(whatsNewStep('1.6.0', '1.5.3', true)).toBe('record');
  });

  test("after an update the toast links to the version's section, once", async () => {
    localStorage.setItem(seenKey, '1.5.2');
    await load();
    expect(env.toast).toHaveBeenCalledTimes(1);
    const options = env.toast.mock.calls[0]?.[0];
    expect(options.message).toBe('rooster was updated to 1.5.3.');
    options.action.onAction();
    expect(env.navigate).toHaveBeenCalledWith({ href: '/help/whats-new#153' });
    expect(whatsNewHref('1.5.3')).toBe('/help/whats-new#153');
    expect(localStorage.getItem(seenKey)).toBe('1.5.3');
    await load();
    expect(env.toast).toHaveBeenCalledTimes(1);
  });

  test('a first visit on this browser says nothing, and records the version', async () => {
    await load();
    expect(env.toast).not.toHaveBeenCalled();
    expect(localStorage.getItem(seenKey)).toBe('1.5.3');
  });

  test('an account from before "What\'s new" that used this browser is told', async () => {
    env.startOwner = 'u1';
    await load();
    expect(env.toast).toHaveBeenCalledTimes(1);
  });

  test('a release without a section shows nothing, but counts as seen', async () => {
    localStorage.setItem(seenKey, '1.5.2');
    env.html = '<h2 id="152">1.5.2</h2>';
    await load();
    expect(env.toast).not.toHaveBeenCalled();
    expect(localStorage.getItem(seenKey)).toBe('1.5.3');
  });
});
