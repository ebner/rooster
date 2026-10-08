import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServiceWorkerControls, UpdateCheckResult } from './sw-registration';
import {
  createUpdateController,
  foregroundCheckMs,
  repromptMs,
  useUpdateStore,
} from './update-controller';

function fakeSw(check: UpdateCheckResult = 'found') {
  let waiting = false;
  const controls = {
    apply: vi.fn(() => {
      waiting = false;
    }),
    hasWaiting: () => waiting,
    check: vi.fn(async () => check),
  } satisfies ServiceWorkerControls;
  const setWaiting = (value: boolean) => {
    waiting = value;
  };
  return { controls, setWaiting };
}

function setup(options: { sw?: ServiceWorkerControls | null; pending?: number } = {}) {
  const state = { pending: options.pending ?? 0, editing: false, time: 1_000_000 };
  const listeners = new Set<() => void>();
  const deps = {
    sw: Promise.resolve(options.sw ?? null),
    pending: () => state.pending,
    editing: () => state.editing,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reload: vi.fn(),
    prompt: vi.fn(),
    deferredNotice: vi.fn(),
    now: () => state.time,
  };
  const controller = createUpdateController(deps);
  const change = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    for (const listener of [...listeners]) listener();
  };
  return { controller, deps, state, change, listeners };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  useUpdateStore.setState({ available: false, deferred: false });
});

describe('update controller (FR-PWA-6)', () => {
  test('a waiting worker shows the prompt once and the chip state', () => {
    const { controller, deps } = setup();
    controller.needRefresh();
    controller.needRefresh();
    expect(deps.prompt).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState()).toEqual({ available: true, deferred: false });
  });

  test('without a service worker a newer server prompts, and Reload reloads the page', async () => {
    const { controller, deps } = setup({ sw: null });
    await controller.serverNewer();
    expect(deps.prompt).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().available).toBe(true);
    controller.request();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  test('with a service worker a newer server only checks; the waiting worker prompts', async () => {
    const { controls } = fakeSw('found');
    const { controller, deps } = setup({ sw: controls });
    await controller.serverNewer();
    expect(controls.check).toHaveBeenCalledOnce();
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().available).toBe(false);
  });

  test('a worker that is already the latest makes Reload a plain reload', async () => {
    const { controls } = fakeSw('current');
    const { controller, deps } = setup({ sw: controls });
    await controller.serverNewer();
    expect(deps.prompt).toHaveBeenCalledOnce();
    controller.request();
    expect(controls.apply).not.toHaveBeenCalled();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  test('an unanswered check (offline) prompts nothing', async () => {
    const { controls } = fakeSw('unknown');
    const { controller, deps } = setup({ sw: controls });
    await controller.serverNewer();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  test('Reload activates the waiting worker; its takeover reloads', async () => {
    const { controls, setWaiting } = fakeSw();
    const { controller, deps } = setup({ sw: controls });
    await flush();
    setWaiting(true);
    controller.needRefresh();
    controller.request();
    expect(controls.apply).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
    controller.controllerChange();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  test('a deferred reload happens once the outbox drains and editing stops', async () => {
    const { controls, setWaiting } = fakeSw();
    const { controller, deps, change, listeners } = setup({ sw: controls, pending: 2 });
    await flush();
    setWaiting(true);
    controller.needRefresh();
    change({ editing: true });
    controller.request();
    expect(useUpdateStore.getState().deferred).toBe(true);
    expect(deps.deferredNotice).toHaveBeenCalledOnce();
    // Pressing the chip again while it waits says nothing new.
    controller.request();
    expect(deps.deferredNotice).toHaveBeenCalledOnce();

    change({ pending: 0 });
    expect(controls.apply).not.toHaveBeenCalled();
    change({ pending: 1, editing: false });
    expect(controls.apply).not.toHaveBeenCalled();
    change({ pending: 0 });
    expect(controls.apply).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().deferred).toBe(false);
    expect(listeners.size).toBe(0);
  });

  test('another tab activating the new worker reloads this one only when it is safe', async () => {
    const { controls } = fakeSw();
    const { controller, deps, change } = setup({ sw: controls });
    await flush();
    controller.needRefresh();
    change({ editing: true });
    controller.controllerChange();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toEqual({ available: true, deferred: true });
    change({ editing: false });
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  test('foreground and online look for a new worker at most every 5 minutes', async () => {
    const { controls } = fakeSw('current');
    const { controller, state } = setup({ sw: controls });
    await flush();
    controller.foreground('visible');
    expect(controls.check).not.toHaveBeenCalled();
    state.time += foregroundCheckMs;
    controller.foreground('online');
    controller.foreground('visible');
    expect(controls.check).toHaveBeenCalledOnce();
    state.time += foregroundCheckMs;
    controller.foreground('visible');
    expect(controls.check).toHaveBeenCalledTimes(2);
  });

  test('back in the foreground, a waiting update prompts again (not every time)', () => {
    const { controller, deps, state } = setup();
    controller.foreground('visible');
    expect(deps.prompt).not.toHaveBeenCalled();
    controller.needRefresh();
    controller.foreground('visible');
    expect(deps.prompt).toHaveBeenCalledOnce();
    state.time += repromptMs;
    controller.foreground('online');
    expect(deps.prompt).toHaveBeenCalledOnce();
    controller.foreground('visible');
    expect(deps.prompt).toHaveBeenCalledTimes(2);
    controller.foreground('visible');
    expect(deps.prompt).toHaveBeenCalledTimes(2);
  });

  test('no prompt again while a reload is already waiting', () => {
    const { controller, deps, state } = setup({ pending: 1 });
    controller.needRefresh();
    controller.request();
    state.time += repromptMs;
    controller.foreground('visible');
    expect(deps.prompt).toHaveBeenCalledOnce();
  });

  test('dispose stops a waiting reload', () => {
    const { controller, deps, change } = setup({ pending: 1 });
    controller.needRefresh();
    controller.request();
    controller.dispose();
    change({ pending: 0 });
    expect(deps.reload).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().deferred).toBe(false);
    controller.controllerChange();
    expect(deps.reload).not.toHaveBeenCalled();
  });
});
