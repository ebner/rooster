import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { keymap, matchesSequence, matchesShortcut, matchesTabChord, shortcutsIn } from './keymap';
import {
  createKeymapDispatcher,
  isTextInput,
  type ShortcutHandlers,
  sequenceTimeoutMs,
  useKeymap,
  useKeymapHandlers,
} from './use-keymap';

function Harness({ handlers }: { handlers: ShortcutHandlers }) {
  useKeymap();
  useKeymapHandlers(handlers);
  return (
    <div>
      <button type="button">before</button>
      <div data-list-root>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a list title is a tab stop. */}
        <span tabIndex={0} data-testid="title">
          Title
        </span>
        <input data-list-input aria-label="list title" />
        <button type="button">date</button>
      </div>
      <input aria-label="other input" />
      <div role="dialog">
        <button type="button">in dialog</button>
      </div>
    </div>
  );
}

const key = (target: Element, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

describe('keymap registry', () => {
  test('symbols ignore Shift (layout-dependent), letters do not', () => {
    const ev = (k: string, shift = false) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: shift,
    });
    expect(matchesShortcut(ev('?', true), '?', 'other')).toBe(true);
    expect(matchesShortcut(ev('N', true), 'N', 'other')).toBe(false);
    expect(matchesShortcut(ev('N', true), 'Shift+N', 'other')).toBe(true);
    expect(matchesShortcut(ev(' '), 'Space', 'other')).toBe(true);
    expect(matchesShortcut({ ...ev('!'), ctrlKey: true, code: 'Digit1' }, 'Mod+1', 'other')).toBe(
      true,
    );
  });

  test('chords and sequences are matched separately from plain keys', () => {
    const n = { key: 'n', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(matchesTabChord(n, 'newGroup', 'other')).toBe(true);
    expect(matchesTabChord(n, 'newBelowNavigate', 'other')).toBe(false);
    expect(matchesSequence({ ...n, key: 'm' }, 'goMyTasks')).toBe(true);
    expect(matchesSequence({ ...n, key: 'm', ctrlKey: true }, 'goMyTasks')).toBe(false);
  });

  test('every shortcut has a scope and section; Tab chords are list-scoped', () => {
    for (const id of shortcutsIn('global', 'navigate', 'list', 'edit', 'drag', 'picker')) {
      const def = keymap[id];
      expect(def.keys.length).toBeGreaterThan(0);
      if (def.keys.some((k: string) => k.startsWith('Tab+'))) expect(def.scope).toBe('list');
    }
  });

  test('isTextInput', () => {
    const input = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isTextInput(input)).toBe(true);
    expect(isTextInput(checkbox)).toBe(false);
    expect(isTextInput(document.createElement('textarea'))).toBe(true);
    expect(isTextInput(null)).toBe(false);
  });
});

describe('useKeymap dispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('navigate keys fire only outside text inputs and dialogs', () => {
    const newBelow = vi.fn();
    const { getByTestId, getByLabelText, getByText } = render(
      <Harness handlers={{ newBelowNavigate: newBelow }} />,
    );
    key(getByTestId('title'), { key: 'n' });
    expect(newBelow).toHaveBeenCalledTimes(1);
    key(getByLabelText('list title'), { key: 'n' });
    key(getByLabelText('other input'), { key: 'n' });
    key(getByText('in dialog'), { key: 'n' });
    expect(newBelow).toHaveBeenCalledTimes(1);
  });

  test('list chords work in the list title input; global chords everywhere', () => {
    const complete = vi.fn();
    const undo = vi.fn();
    const { getByLabelText } = render(<Harness handlers={{ complete, undo }} />);
    const event = key(getByLabelText('list title'), { key: 'Enter', ctrlKey: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(event).toBe(false); // preventDefault
    key(getByLabelText('other input'), { key: 'Enter', ctrlKey: true });
    expect(complete).toHaveBeenCalledTimes(1);
    key(getByLabelText('other input'), { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  test('a handler returning false leaves the event alone', () => {
    const { getByTestId } = render(<Harness handlers={{ deleteNavigate: () => false }} />);
    expect(key(getByTestId('title'), { key: 'Delete' })).toBe(true);
  });

  test('Tab+N fires the chord and keeps focus; Tab alone moves focus like native Tab', () => {
    const newGroup = vi.fn();
    const { getByTestId, getByLabelText } = render(<Harness handlers={{ newGroup }} />);
    const title = getByTestId('title');
    title.getClientRects = () => [{}] as unknown as DOMRectList;
    const input = getByLabelText('list title');
    input.getClientRects = () => [{}] as unknown as DOMRectList;
    title.focus();
    expect(key(title, { key: 'Tab' })).toBe(false);
    key(title, { key: 'n' });
    fireEvent.keyUp(title, { key: 'Tab' });
    expect(newGroup).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(title);

    key(title, { key: 'Tab' });
    fireEvent.keyUp(title, { key: 'Tab' });
    expect(newGroup).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  test('Tab outside the list stays native', () => {
    render(<Harness handlers={{}} />);
    const before = document.querySelector('button') as HTMLButtonElement;
    expect(key(before, { key: 'Tab' })).toBe(true);
  });

  test('G then M navigates; G suspends M and other single keys; it times out', () => {
    const goMyTasks = vi.fn();
    const moveTo = vi.fn();
    const { getByTestId } = render(<Harness handlers={{ goMyTasks, moveToNavigate: moveTo }} />);
    const title = getByTestId('title');
    key(title, { key: 'g' });
    key(title, { key: 'm' });
    expect(goMyTasks).toHaveBeenCalledTimes(1);
    expect(moveTo).not.toHaveBeenCalled();

    key(title, { key: 'g' });
    key(title, { key: 'x' });
    expect(goMyTasks).toHaveBeenCalledTimes(1);

    key(title, { key: 'g' });
    vi.advanceTimersByTime(sequenceTimeoutMs + 1);
    key(title, { key: 'm' });
    expect(moveTo).toHaveBeenCalledTimes(1);
  });

  test('the latest mounted handler layer wins; unmounting restores the previous one', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Inner() {
      useKeymapHandlers({ quickAddNavigate: inner });
      return null;
    }
    const { getByTestId, rerender } = render(
      <>
        <Harness handlers={{ quickAddNavigate: outer }} />
        <Inner />
      </>,
    );
    key(getByTestId('title'), { key: 'q' });
    expect(inner).toHaveBeenCalledTimes(1);
    rerender(<Harness handlers={{ quickAddNavigate: outer }} />);
    key(getByTestId('title'), { key: 'q' });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  test('reset clears a held Tab (e.g. on window blur)', () => {
    const dispatcher = createKeymapDispatcher('other');
    const root = document.createElement('div');
    root.setAttribute('data-list-root', '');
    const span = document.createElement('span');
    root.append(span);
    document.body.append(root);
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    span.dispatchEvent(event);
    dispatcher.onKeyDown(Object.defineProperty(event, 'target', { value: span }));
    expect(dispatcher.state.tab).not.toBeNull();
    dispatcher.reset();
    expect(dispatcher.state.tab).toBeNull();
    root.remove();
  });
});
