/**
 * FR-PWA-6: the app never reloads into a new version while the outbox holds ops or the user
 * is typing in a title or description. "Reload" asks the gate; it applies the update at once
 * when that is safe, otherwise as soon as it becomes safe.
 */
export interface UpdateGateDeps {
  /** Ops still queued (all tabs share the outbox). */
  pending: () => number;
  /** A text editor has focus. */
  editing: () => boolean;
  /** Calls `listener` whenever `pending` or `editing` may have changed. */
  subscribe: (listener: () => void) => () => void;
  /** Activates the waiting worker; the page reloads once it controls it. */
  apply: () => void;
}

export type UpdateRequest = 'applied' | 'deferred';

export interface UpdateGate {
  request(): UpdateRequest;
  /** Reload was asked for and waits for the outbox or the editor. */
  readonly deferred: boolean;
  cancel(): void;
}

export function createUpdateGate(deps: UpdateGateDeps): UpdateGate {
  let requested = false;
  let unsubscribe: (() => void) | null = null;

  const stopWatching = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const tryApply = (): boolean => {
    if (!requested || deps.pending() > 0 || deps.editing()) return false;
    requested = false;
    stopWatching();
    deps.apply();
    return true;
  };

  return {
    request() {
      requested = true;
      if (tryApply()) return 'applied';
      unsubscribe ??= deps.subscribe(() => void tryApply());
      return 'deferred';
    },
    get deferred() {
      return requested;
    },
    cancel() {
      requested = false;
      stopWatching();
    },
  };
}

const textInputTypes = new Set(['text', 'search', 'url', 'email', 'tel', '']);

/** Whether focus is in a text editor: a title input, the description editor, any textarea. */
export function isEditingText(doc: Document = document): boolean {
  const el = doc.activeElement;
  if (!el || el === doc.body) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return textInputTypes.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable === true;
}
