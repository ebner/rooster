import { create } from 'zustand';
import type { ServiceWorkerControls } from './sw-registration';
import { createUpdateGate, type UpdateGateDeps } from './update-gate';

/** What the header's update chip reads (FR-PWA-6). */
export interface UpdateState {
  /** A newer version is deployed and this page still runs the old bundle. */
  available: boolean;
  /** Reload was asked for and waits for the outbox to drain and the editor to close. */
  deferred: boolean;
}

export const useUpdateStore = create<UpdateState>()(() => ({ available: false, deferred: false }));

/** Foreground and `online` look for a new `sw.js` at most this often. */
export const foregroundCheckMs = 5 * 60_000;
/** Back in the foreground, a dismissed prompt shows again, but not more often than this. */
export const repromptMs = 5 * 60_000;

export interface UpdateControllerDeps extends Omit<UpdateGateDeps, 'apply'> {
  /** The service worker, or null when there is none that works (`registerServiceWorker`). */
  sw: Promise<ServiceWorkerControls | null>;
  /** A plain page reload: the new bundle comes from the server (or the already-new worker). */
  reload: () => void;
  /** Shows the "New version available · Reload" toast, replacing an earlier one. */
  prompt: () => void;
  /** Reload is waiting for the outbox or the editor: say so and try to flush now. */
  deferredNotice: () => void;
  now?: () => number;
}

export interface UpdateController {
  /** A new service worker is installed and waiting. */
  needRefresh(): void;
  /** The SSE `hello` reports a newer server than this bundle. */
  serverNewer(): Promise<void>;
  /** A new worker took control (this tab applied it, or another tab did). */
  controllerChange(): void;
  /** "Reload" in the toast or the header chip. */
  request(): void;
  /** The page became visible again, or the network came back. */
  foreground(reason: 'visible' | 'online'): void;
  dispose(): void;
}

/**
 * The update flow behind the toast and the header chip (FR-PWA-6, ADR 0010 §8). With a
 * service worker, Reload activates the waiting worker; without one (unsupported, disabled,
 * failed to register), or when the active worker is already the new one, it reloads the page.
 * Either way the update gate holds it back while ops are queued or a text editor has focus.
 */
export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const now = deps.now ?? Date.now;
  let controls: ServiceWorkerControls | null = null;
  let lastCheckAt = now();
  let lastPromptAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  void deps.sw.then((c) => {
    controls = c;
  });

  const gate = createUpdateGate({
    pending: deps.pending,
    ...(deps.durable ? { durable: deps.durable } : {}),
    editing: deps.editing,
    subscribe: deps.subscribe,
    apply: () => {
      useUpdateStore.setState({ deferred: false });
      // The waiting worker first; its takeover calls `controllerChange`, which reloads.
      if (controls?.hasWaiting()) controls.apply();
      else deps.reload();
    },
  });

  const prompt = () => {
    lastPromptAt = now();
    deps.prompt();
  };

  const markAvailable = () => {
    if (disposed || useUpdateStore.getState().available) return;
    useUpdateStore.setState({ available: true });
    prompt();
  };

  const request = () => {
    if (gate.request() === 'applied') return;
    const wasDeferred = useUpdateStore.getState().deferred;
    useUpdateStore.setState({ available: true, deferred: true });
    if (!wasDeferred) deps.deferredNotice();
  };

  return {
    needRefresh: markAvailable,
    async serverNewer() {
      const sw = await deps.sw;
      if (!sw) return markAvailable();
      // A worker that is already the server's latest serves the new shell on a plain reload
      // (another tab activated it, or it updated after this page loaded).
      if ((await sw.check()) === 'current') markAvailable();
    },
    controllerChange() {
      if (disposed) return;
      useUpdateStore.setState({ available: true });
      request();
    },
    request,
    foreground(reason) {
      if (disposed) return;
      const at = now();
      if (at - lastCheckAt >= foregroundCheckMs) {
        lastCheckAt = at;
        void controls?.check();
      }
      const { available, deferred } = useUpdateStore.getState();
      if (reason === 'visible' && available && !deferred && at - lastPromptAt >= repromptMs) {
        prompt();
      }
    },
    dispose() {
      disposed = true;
      gate.cancel();
      useUpdateStore.setState({ deferred: false });
    },
  };
}

let active: UpdateController | null = null;

/** The mounted controller (`PwaRoot`), for the header chip. */
export function updateController(): UpdateController | null {
  return active;
}

export function setUpdateController(controller: UpdateController | null): void {
  active = controller;
}
