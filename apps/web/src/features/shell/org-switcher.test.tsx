import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Org } from '../../data/types';
import { longPressMs } from '../list/gestures';
import { fixtureMe } from './fixtures';
import { OrgSwitcher } from './org-switcher';
import { switchView } from './sidebar-views';

function fixtureOrg(index: number): Org {
  const org = fixtureMe.orgs[index];
  if (!org) throw new Error(`no fixture org ${index}`);
  return org;
}

const personal = fixtureOrg(0);
const company = fixtureOrg(1);
const orgs = [personal, company];

function setup(org = personal) {
  const onOpen = vi.fn();
  const onSwitch = vi.fn();
  const slide = { start: vi.fn(), move: vi.fn(), end: vi.fn() };
  render(<OrgSwitcher org={org} orgs={orgs} onOpen={onOpen} onSwitch={onSwitch} slide={slide} />);
  return { onOpen, onSwitch, slide, button: screen.getByTestId('org-switcher') };
}

/** One touch gesture on the switcher, from x = 100 to `x0 + dx`, in `steps` moves. */
function drag(target: Element, dx: number, dy = 0, steps = 5, pointerType = 'touch') {
  const at = (x: number, y: number) => ({
    pointerId: 1,
    pointerType,
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  fireEvent.pointerDown(target, at(100, 20));
  for (let i = 1; i <= steps; i += 1) {
    fireEvent.pointerMove(target, at(100 + (dx * i) / steps, 20 + (dy * i) / steps));
  }
  fireEvent.pointerUp(target, at(100 + dx, 20 + dy));
}

beforeEach(() => {
  vi.useFakeTimers();
  // A 400 px screen: a swipe commits past 30 % of half of it.
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(400);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OrgSwitcher (ADR 0063)', () => {
  test('a swipe to the left switches to the next org, and does not open the sheet', () => {
    const { onSwitch, onOpen, button } = setup(personal);
    drag(button, -120);
    fireEvent.click(button);
    act(() => vi.runAllTimers());
    expect(onSwitch).toHaveBeenCalledWith(company);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('a swipe to the right switches to the previous org', () => {
    const { onSwitch, button } = setup(company);
    drag(button, 120);
    act(() => vi.runAllTimers());
    expect(onSwitch).toHaveBeenCalledWith(personal);
  });

  test('past the first or last org a swipe only springs back', () => {
    const { onSwitch, button } = setup(personal);
    drag(button, 120);
    act(() => vi.runAllTimers());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test('a short, slow swipe springs back', () => {
    const { onSwitch, button } = setup(personal);
    // 30 px in 20 slow moves: under 30 % of 200 px and no fling.
    const at = (x: number, t: number) => ({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: 20,
      timeStamp: t,
    });
    fireEvent.pointerDown(button, at(100, 0));
    for (let i = 1; i <= 20; i += 1) fireEvent.pointerMove(button, at(100 - (30 * i) / 20, i * 50));
    fireEvent.pointerUp(button, at(70, 1000));
    act(() => vi.runAllTimers());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test('a vertical move is not a swipe', () => {
    const { onSwitch, button } = setup(personal);
    drag(button, -30, 60);
    act(() => vi.runAllTimers());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test('a mouse drag is a plain press: it opens the sheet and switches nothing', () => {
    const { onSwitch, onOpen, button } = setup(personal);
    drag(button, -120, 0, 5, 'mouse');
    act(() => vi.runAllTimers());
    expect(onSwitch).not.toHaveBeenCalled();
    // A mouse press and release on the button is a plain press: the sheet opens.
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test('press-and-slide: a long-press opens the sheet, lifting over an org picks it', () => {
    const { slide, onOpen, button } = setup(personal);
    const option = document.createElement('div');
    option.dataset.orgOption = company.id;
    document.body.append(option);
    document.elementFromPoint = vi.fn(() => option);
    const at = (y: number) => ({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 100,
      clientY: y,
    });
    fireEvent.pointerDown(button, at(20));
    act(() => vi.advanceTimersByTime(longPressMs));
    expect(slide.start).toHaveBeenCalledOnce();
    fireEvent.pointerMove(button, at(300));
    expect(slide.move).toHaveBeenLastCalledWith(company.id);
    fireEvent.pointerUp(button, at(300));
    fireEvent.click(button);
    expect(slide.end).toHaveBeenCalledWith(company.id);
    expect(onOpen).not.toHaveBeenCalled();
    option.remove();
  });

  test('a press that moves before the long-press is not a slide', () => {
    const { slide, button } = setup(personal);
    const at = (x: number) => ({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: 20,
    });
    fireEvent.pointerDown(button, at(100));
    fireEvent.pointerMove(button, at(80));
    act(() => vi.advanceTimersByTime(longPressMs * 2));
    expect(slide.start).not.toHaveBeenCalled();
  });

  test('dots show the position among the orgs', () => {
    setup(company);
    const dots = screen.getByTestId('org-dots').children;
    expect(dots).toHaveLength(2);
    expect(dots[1]?.className).toContain('bg-text-secondary');
  });
});

describe('switchView', () => {
  test('keeps the view the other org has, otherwise My tasks', () => {
    expect(switchView('today', personal)).toBe('today');
    expect(switchView('everyone', company)).toBe('everyone');
    expect(switchView('everyone', personal)).toBe('my');
    expect(switchView(null, company)).toBe('my');
  });
});
