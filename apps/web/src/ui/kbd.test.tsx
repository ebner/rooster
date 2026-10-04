import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { detectPlatform } from '../lib/platform';
import { formatShortcut, Kbd, shortcutLabel } from './kbd';

describe('shortcut labels', () => {
  test.each([
    ['Mod+K', '⌘K', 'Ctrl+K'],
    ['Mod+Shift+Z', '⌘⇧Z', 'Ctrl+Shift+Z'],
    ['Alt+ArrowUp', '⌥↑', 'Alt+↑'],
    ['Escape', 'Esc', 'Esc'],
    ['?', '?', '?'],
    ['d', 'D', 'D'],
  ])('%s → mac %s, other %s', (shortcut, mac, other) => {
    expect(shortcutLabel(shortcut, 'mac')).toBe(mac);
    expect(shortcutLabel(shortcut, 'other')).toBe(other);
  });

  test('formatShortcut returns one label per key', () => {
    expect(formatShortcut('Mod+Enter', 'other')).toEqual(['Ctrl', 'Enter']);
    expect(formatShortcut('Mod+Enter', 'mac')).toEqual(['⌘', '↵']);
  });
});

describe('detectPlatform', () => {
  test.each([
    [{ platform: 'MacIntel' }, 'mac'],
    [{ platform: 'iPhone' }, 'mac'],
    [{ userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ platform: 'Win32' }, 'other'],
    [{ platform: 'Linux x86_64' }, 'other'],
    [{}, 'other'],
  ])('%j → %s', (nav, expected) => {
    expect(detectPlatform(nav)).toBe(expected);
  });
});

describe('Kbd', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('renders ⌘ on macOS with a spelled-out label for screen readers', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    const { container } = render(<Kbd shortcut="Mod+K" />);
    const kbd = container.querySelector('kbd');
    expect(kbd?.querySelector('[aria-hidden]')?.textContent).toBe('⌘K');
    expect(kbd?.querySelector('.sr-only')?.textContent).toBe('Command+K');
  });

  test('renders Ctrl elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
    const { container } = render(<Kbd shortcut="Mod+K" />);
    expect(container.querySelector('kbd [aria-hidden]')?.textContent).toBe('Ctrl+K');
    expect(container.querySelector('kbd .sr-only')?.textContent).toBe('Control+K');
  });

  test('an explicit platform overrides detection', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
    const { container } = render(<Kbd shortcut="Mod+K" platform="mac" />);
    expect(container.querySelector('kbd [aria-hidden]')?.textContent).toBe('⌘K');
  });
});
