import { useEffect, useRef } from 'react';
import {
  type KeyEventLike,
  matches,
  matchesSequence,
  matchesTabChord,
  type ShortcutId,
  type ShortcutScope,
  shortcutsIn,
} from './keymap';
import { detectPlatform, type Platform } from './lib/platform';

/** Returns `false` when it did not handle the key (the event then continues normally). */
export type ShortcutHandler = (event: KeyboardEvent) => unknown;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

interface Layer {
  get: (id: ShortcutId) => ShortcutHandler | undefined;
}

/** Handler layers; the most recently mounted layer wins. */
const layers: Layer[] = [];

/**
 * Registers handlers for registry shortcuts while the component is mounted. The handler
 * object may change every render; the latest one is always called.
 */
export function useKeymapHandlers(handlers: ShortcutHandlers, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const layer: Layer = { get: (id) => ref.current[id] };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, [enabled]);
}

function handlerFor(id: ShortcutId): ShortcutHandler | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const handler = layers[i]?.get(id);
    if (handler) return handler;
  }
  return undefined;
}

/** G-sequence timeout (02 §6). */
export const sequenceTimeoutMs = 1000;

const textInputTypes = /^(text|search|email|url|tel|password|number|date|time|)$/;

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return textInputTypes.test(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

const overlaySelector = '[role="dialog"],[role="menu"],[role="listbox"],[data-overlay]';

function inOverlay(el: Element | null): boolean {
  return Boolean(el?.closest(overlaySelector));
}

function inList(el: Element | null): boolean {
  return Boolean(el?.closest('[data-list-root]')) && !inOverlay(el);
}

const tabbableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

/** Native-like Tab focus movement, for a Tab released without a chord. */
export function moveFocus(direction: 1 | -1, from: Element | null = document.activeElement): void {
  const all = [...document.querySelectorAll<HTMLElement>(tabbableSelector)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'),
  );
  if (all.length === 0) return;
  let index = from instanceof HTMLElement ? all.indexOf(from) : -1;
  if (index < 0 && from) {
    // The focused element is not tabbable itself (e.g. a row): continue from its position.
    index = all.findIndex(
      (el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    index = index < 0 ? all.length : index;
    if (direction === 1) index -= 1;
  }
  const next = all[(index + direction + all.length) % all.length];
  next?.focus();
}

interface DispatchState {
  tab: { shift: boolean; used: boolean } | null;
  sequence: ReturnType<typeof setTimeout> | null;
}

function scopesFor(target: Element | null): ShortcutScope[] {
  if (isTextInput(target)) {
    return target?.matches('[data-list-input]') ? ['global', 'list'] : ['global'];
  }
  return inOverlay(target) ? ['global'] : ['global', 'list', 'navigate'];
}

function run(id: ShortcutId, event: KeyboardEvent): boolean {
  const handler = handlerFor(id);
  if (!handler) return false;
  if (handler(event) === false) return false;
  event.preventDefault();
  return true;
}

/** The dispatcher, separated from React for tests. */
export function createKeymapDispatcher(platform: Platform) {
  const state: DispatchState = { tab: null, sequence: null };
  const listIds = shortcutsIn('list');
  const sequenceIds = shortcutsIn('navigate').filter((id) => id.startsWith('go'));
  const clearSequence = () => {
    if (state.sequence) clearTimeout(state.sequence);
    state.sequence = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Within the list Tab is a chord prefix; a release without a chord moves focus.
      if (!inList(target) || event.defaultPrevented) return;
      event.preventDefault();
      if (!state.tab) state.tab = { shift: event.shiftKey, used: false };
      return;
    }
    if (event.defaultPrevented) return;
    if (state.tab) {
      const id = listIds.find((i) => matchesTabChord(event as KeyEventLike, i, platform));
      if (id && run(id, event)) state.tab.used = true;
      return;
    }
    if (state.sequence) {
      clearSequence();
      const id = sequenceIds.find((i) => matchesSequence(event, i));
      if (id) run(id, event);
      else event.preventDefault();
      return;
    }
    const scopes = scopesFor(target);
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (scopes.includes('navigate') && plain && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      state.sequence = setTimeout(clearSequence, sequenceTimeoutMs);
      return;
    }
    for (const scope of scopes) {
      for (const id of shortcutsIn(scope)) {
        if (matches(event, id, platform) && run(id, event)) return;
      }
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !state.tab) return;
    const { shift, used } = state.tab;
    state.tab = null;
    if (!used) moveFocus(shift ? -1 : 1);
  };

  const reset = () => {
    state.tab = null;
    clearSequence();
  };

  return { onKeyDown, onKeyUp, reset, state };
}

/** Mount once at the root: the single document listener for the registry (04 §5.3). */
export function useKeymap(): void {
  useEffect(() => {
    const dispatcher = createKeymapDispatcher(detectPlatform());
    document.addEventListener('keydown', dispatcher.onKeyDown);
    document.addEventListener('keyup', dispatcher.onKeyUp);
    window.addEventListener('blur', dispatcher.reset);
    return () => {
      dispatcher.reset();
      document.removeEventListener('keydown', dispatcher.onKeyDown);
      document.removeEventListener('keyup', dispatcher.onKeyUp);
      window.removeEventListener('blur', dispatcher.reset);
    };
  }, []);
}
