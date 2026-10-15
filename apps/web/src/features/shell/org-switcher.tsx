import { ChevronDown } from 'lucide-react';
import { type PointerEvent, useLayoutEffect, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import {
  longPressMs,
  longPressSlopPx,
  motionMs,
  swipeCommits,
  swipeResistance,
  swipeSlopPx,
} from '../list/gestures';

/** Press-and-slide (ADR 0063): the sheet opens under the finger, and letting go picks an org. */
export interface OrgSlide {
  /** The long-press fired: open the org sheet. */
  start: () => void;
  /** The org option under the finger, or null. */
  move: (orgId: string | null) => void;
  /** The finger lifted over `orgId` (switch to it), or elsewhere (null: the sheet stays). */
  end: (orgId: string | null) => void;
}

export interface OrgSwitcherProps {
  org: Org;
  /** All of the user's orgs, in sidebar order: the swipe's neighbours and the dots. */
  orgs: readonly Org[];
  onOpen?: (() => void) | undefined;
  onSwitch?: ((org: Org) => void) | undefined;
  slide?: OrgSlide | undefined;
}

/** More orgs than this and the dots would crowd the header; the swipe still works. */
const maxDots = 7;

/** The org option under a point of the screen (`data-org-option` on the sheet's rows). */
function orgOptionAt(x: number, y: number): string | null {
  const option = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-org-option]');
  return option?.dataset.orgOption ?? null;
}

interface Gesture {
  pointerId: number;
  x0: number;
  y0: number;
  lastX: number;
  lastT: number;
  velocity: number;
  dx: number;
  phase: 'pending' | 'swiping' | 'sliding' | 'done';
  timer: number | undefined;
}

/**
 * Where the next switcher should slide its org in from: set when a swipe commits, read once
 * by the switcher that renders that org (the header may remount with the new route).
 */
let entering: { orgId: string; from: 1 | -1 } | null = null;

/**
 * The phone header's org switcher (02 §13.1, ADR 0063): a tap opens the org sheet; a sideways
 * swipe moves to the next or previous org in sidebar order, the name following the finger
 * with the neighbour's name sliding in behind it; a long-press opens the sheet under the
 * finger, and lifting over an org switches to it. Touch only: a mouse and the keyboard use
 * the sheet (and Mod+1…9).
 */
export function OrgSwitcher({ org, orgs, onOpen, onSwitch, slide }: OrgSwitcherProps) {
  const { t } = useTranslation('mobile');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The press that ended a gesture must not also open the sheet. */
  const consumed = useRef(false);
  const live = useRef({ onSwitch, slide });
  live.current = { onSwitch, slide };

  const index = orgs.findIndex((o) => o.id === org.id);
  const previous = index > 0 ? orgs[index - 1] : undefined;
  const next = index >= 0 ? orgs[index + 1] : undefined;

  const setOffset = (px: number, transition: string | null) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = transition ?? 'none';
    track.style.transform = px === 0 ? '' : `translateX(${px}px)`;
  };

  /** While the name moves, the button's pressed background would frame it like a tab. */
  const setSwiping = (swiping: boolean) => {
    const button = buttonRef.current;
    if (button) button.style.backgroundColor = swiping ? 'transparent' : '';
  };

  // A committed swipe: the new org's name slides in from the side the old one left by.
  useLayoutEffect(() => {
    if (entering?.orgId !== org.id) return;
    const from = entering.from;
    entering = null;
    const width = buttonRef.current?.getBoundingClientRect().width ?? 0;
    setOffset(from * width, null);
    trackRef.current?.getBoundingClientRect();
    setOffset(0, 'transform var(--dur-base) var(--ease-standard)');
  }, [org.id]);

  const stop = (g: Gesture) => {
    clearTimeout(g.timer);
    g.phase = 'done';
    gesture.current = null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    consumed.current = false;
    const g: Gesture = {
      pointerId: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
      dx: 0,
      phase: 'pending',
      timer: undefined,
    };
    if (live.current.slide) {
      g.timer = window.setTimeout(() => {
        if (g.phase !== 'pending') return;
        g.phase = 'sliding';
        consumed.current = true;
        navigator.vibrate?.(10);
        live.current.slide?.start();
      }, longPressMs);
    }
    gesture.current = g;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    if (g.phase === 'sliding') {
      live.current.slide?.move(orgOptionAt(event.clientX, event.clientY));
      return;
    }
    const dx = event.clientX - g.x0;
    const dy = event.clientY - g.y0;
    if (g.phase === 'pending') {
      if (Math.hypot(dx, dy) > longPressSlopPx) clearTimeout(g.timer);
      if (Math.abs(dy) > swipeSlopPx && Math.abs(dy) >= Math.abs(dx)) {
        stop(g);
        return;
      }
      if (!live.current.onSwitch || orgs.length < 2) return;
      if (Math.abs(dx) <= swipeSlopPx || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      g.phase = 'swiping';
      consumed.current = true;
      setSwiping(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic or already released pointers cannot be captured; moves still bubble.
      }
    }
    const dt = Math.max(1, event.timeStamp - g.lastT);
    g.velocity = (event.clientX - g.lastX) / dt;
    g.lastX = event.clientX;
    g.lastT = event.timeStamp;
    g.dx = dx;
    // Left brings the next org in, right the previous one; past the ends it only stretches.
    const towards = dx < 0 ? next : previous;
    setOffset(towards ? dx : dx * swipeResistance, null);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const phase = g.phase;
    stop(g);
    if (phase === 'sliding') {
      live.current.slide?.end(cancelled ? null : orgOptionAt(event.clientX, event.clientY));
      return;
    }
    if (phase !== 'swiping') return;
    setSwiping(false);
    const towards = g.dx < 0 ? next : previous;
    // The commit distance is the name's width, but never so short that a nudge switches.
    const width = buttonRef.current?.getBoundingClientRect().width ?? 0;
    const span = Math.max(width, document.documentElement.clientWidth / 2);
    if (cancelled || !towards || !swipeCommits(g.dx, g.velocity, span)) {
      setOffset(0, 'transform var(--dur-base) var(--ease-spring)');
      return;
    }
    const from = g.dx < 0 ? 1 : -1;
    setOffset(-from * width, 'transform var(--dur-fast) var(--ease-exit)');
    setTimeout(() => {
      entering = { orgId: towards.id, from };
      live.current.onSwitch?.(towards);
    }, motionMs('fast'));
  };

  const dots = orgs.length > 1 && orgs.length <= maxDots;
  const neighbour = (other: Org, side: 'before' | 'after') => (
    <span
      aria-hidden
      className={cn(
        'absolute inset-y-0 flex items-center gap-2',
        side === 'before' ? 'right-full pe-6' : 'left-full ps-6',
      )}
    >
      <Avatar
        id={other.id}
        name={other.name}
        emoji={other.avatarEmoji}
        color={other.color}
        shape="square"
        size={24}
        decorative
      />
      <span className="whitespace-nowrap text-group text-text">{other.name}</span>
    </span>
  );

  return (
    <div
      className="flex min-w-0 touch-none select-none touch-callout-none"
      data-testid="org-switcher-gestures"
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={(event) => finish(event, false)}
      onPointerCancelCapture={(event) => finish(event, true)}
    >
      <AriaButton
        ref={buttonRef}
        onPress={() => {
          if (consumed.current) {
            consumed.current = false;
            return;
          }
          onOpen?.();
        }}
        aria-label={t('org.switch', { name: org.name })}
        data-testid="org-switcher"
        className={cn(
          'relative flex h-hit-touch min-w-0 cursor-default items-center overflow-hidden rounded-sm px-2',
          'transition-colors duration-(--dur-fast) pressed:bg-bg-muted',
          'outline-none focus-ring:outline-2 focus-ring:outline-border-focus',
        )}
      >
        <span ref={trackRef} className="relative flex min-w-0 items-center gap-2">
          {previous && neighbour(previous, 'before')}
          <Avatar
            id={org.id}
            name={org.name}
            emoji={org.avatarEmoji}
            color={org.color}
            shape="square"
            size={24}
            decorative
          />
          <span className="min-w-0 truncate text-group text-text">{org.name}</span>
          <ChevronDown
            className="size-4 shrink-0 text-text-secondary"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
          {next && neighbour(next, 'after')}
        </span>
        {dots && (
          <span
            aria-hidden
            data-testid="org-dots"
            className="absolute inset-x-0 bottom-0.5 flex justify-center gap-1"
          >
            {orgs.map((o) => (
              <span
                key={o.id}
                className={cn(
                  'size-1 rounded-full',
                  o.id === org.id ? 'bg-text-secondary' : 'bg-border-strong',
                )}
              />
            ))}
          </span>
        )}
      </AriaButton>
    </div>
  );
}
