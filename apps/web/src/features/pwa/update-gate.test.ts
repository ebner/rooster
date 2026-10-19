import { afterEach, describe, expect, test, vi } from 'vitest';
import { createUpdateGate, isEditingText } from './update-gate';

function setup(initial: { pending: number; editing: boolean; durable?: boolean }) {
  const state = { durable: false, ...initial };
  const listeners = new Set<() => void>();
  const apply = vi.fn();
  const gate = createUpdateGate({
    pending: () => state.pending,
    durable: () => state.durable,
    stuckMs: 1_000,
    editing: () => state.editing,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply,
  });
  const change = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    for (const listener of [...listeners]) listener();
  };
  return { gate, apply, change, listeners };
}

describe('update gate (FR-PWA-6)', () => {
  test('applies at once when nothing is pending and nobody types', () => {
    const { gate, apply } = setup({ pending: 0, editing: false });
    expect(gate.request()).toBe('applied');
    expect(apply).toHaveBeenCalledOnce();
  });

  test('waits for the outbox to empty, then reloads', () => {
    const { gate, apply, change, listeners } = setup({ pending: 2, editing: false });
    expect(gate.request()).toBe('deferred');
    expect(gate.deferred).toBe(true);
    change({ pending: 1 });
    expect(apply).not.toHaveBeenCalled();
    change({ pending: 0 });
    expect(apply).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(gate.deferred).toBe(false);
  });

  test('waits while an editor has focus', () => {
    const { gate, apply, change } = setup({ pending: 0, editing: true });
    expect(gate.request()).toBe('deferred');
    change({ pending: 0 });
    expect(apply).not.toHaveBeenCalled();
    change({ editing: false });
    expect(apply).toHaveBeenCalledOnce();
  });

  test('cancel stops waiting', () => {
    const { gate, apply, change } = setup({ pending: 1, editing: false });
    gate.request();
    gate.cancel();
    change({ pending: 0 });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('update gate with a queue that does not drain (ADR 0021)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('Reload goes through after the wait when every queued op is stored', () => {
    vi.useFakeTimers();
    const { gate, apply } = setup({ pending: 2, editing: false, durable: true });
    expect(gate.request()).toBe('deferred');
    vi.advanceTimersByTime(999);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledOnce();
  });

  test('an op that lives in memory only keeps holding it, until it is stored', () => {
    vi.useFakeTimers();
    const { gate, apply, change } = setup({ pending: 1, editing: false, durable: false });
    gate.request();
    vi.advanceTimersByTime(5_000);
    expect(apply).not.toHaveBeenCalled();
    change({ durable: true });
    expect(apply).toHaveBeenCalledOnce();
  });

  test('the wait starts again with the next request after a cancel', () => {
    vi.useFakeTimers();
    const { gate, apply } = setup({ pending: 1, editing: false, durable: true });
    gate.request();
    vi.advanceTimersByTime(600);
    gate.cancel();
    gate.request();
    vi.advanceTimersByTime(600);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(apply).toHaveBeenCalledOnce();
  });
});

describe('isEditingText', () => {
  test('text inputs, textareas and contenteditable count; buttons and checkboxes do not', () => {
    document.body.innerHTML = `
      <input id="title" type="text" /><input id="check" type="checkbox" />
      <textarea id="area"></textarea><div id="editor" contenteditable="true"></div>
      <button id="button">x</button>`;
    const focus = (id: string) => (document.getElementById(id) as HTMLElement).focus();
    expect(isEditingText()).toBe(false);
    focus('title');
    expect(isEditingText()).toBe(true);
    focus('check');
    expect(isEditingText()).toBe(false);
    focus('area');
    expect(isEditingText()).toBe(true);
    focus('button');
    expect(isEditingText()).toBe(false);
    const editor = document.getElementById('editor') as HTMLElement;
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    editor.tabIndex = 0;
    editor.focus();
    expect(isEditingText()).toBe(true);
  });
});
