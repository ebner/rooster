import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  eventZone,
  hasShortcutHandler,
  runShortcut,
  type ShortcutHandlers,
  useKeymapHandlers,
} from '../../use-keymap';

function Layer({ handlers }: { handlers: ShortcutHandlers }) {
  useKeymapHandlers(handlers);
  return null;
}

describe('runShortcut (palette actions dispatch like their keys)', () => {
  test('runs the topmost handler that accepts; false falls through', () => {
    const below = vi.fn();
    const above = vi.fn(() => false);
    render(
      <>
        <Layer handlers={{ moveTo: below }} />
        <Layer handlers={{ moveTo: above }} />
      </>,
    );
    expect(hasShortcutHandler('moveTo')).toBe(true);
    expect(runShortcut('moveTo')).toBe(true);
    expect(above).toHaveBeenCalledOnce();
    expect(below).toHaveBeenCalledOnce();
  });

  test('no handler: not handled', () => {
    expect(hasShortcutHandler('openAdmin')).toBe(false);
    expect(runShortcut('openAdmin')).toBe(false);
  });

  test('the event carries the target (focus zone) and key arguments', () => {
    const seen: { zone: string; key: string; code: string; ctrl: boolean }[] = [];
    const list = document.createElement('div');
    list.setAttribute('data-list-root', '');
    const row = document.createElement('button');
    list.append(row);
    document.body.append(list);
    render(
      <Layer
        handlers={{
          goToOrg: (event) => {
            seen.push({
              zone: eventZone(event),
              key: event.key,
              code: event.code,
              ctrl: event.ctrlKey || event.metaKey,
            });
          },
        }}
      />,
    );
    runShortcut('goToOrg', { target: row, key: '3', code: 'Digit3' });
    expect(seen).toEqual([{ zone: 'list', key: '3', code: 'Digit3', ctrl: true }]);
    list.remove();
  });
});
