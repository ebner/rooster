import { CircleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';
import { IconButton } from './icon-button';

/** 02 §14 / 03 §3.9: at most 3 stacked, 6 s each, paused while hovered or focused. */
export const maxVisibleToasts = 3;
export const defaultToastDurationMs = 6000;

export type ToastTone = 'info' | 'danger';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  message: string;
  /** `danger` uses role="alert" and the alert icon; `info` is a polite status. */
  tone?: ToastTone;
  /** At most one action per toast (02 §14). */
  action?: ToastAction;
  durationMs?: number;
}

interface ToastRecord {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  durationMs: number;
}

interface ToastStore {
  toasts: ToastRecord[];
  add: (toast: ToastRecord) => void;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],
  // New toasts join at the bottom; the oldest leaves when the stack is full.
  add: (toast) => set((s) => ({ toasts: [...s.toasts, toast].slice(-maxVisibleToasts) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let nextId = 0;

/** Shows a toast and returns its id. Messages must already be translated. */
export function toast({
  message,
  tone = 'info',
  action,
  durationMs = defaultToastDurationMs,
}: ToastOptions): string {
  nextId += 1;
  const id = `toast-${nextId}`;
  useToastStore.getState().add({ id, message, tone, durationMs, ...(action ? { action } : {}) });
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

export function clearToasts(): void {
  useToastStore.setState({ toasts: [] });
}

function useAutoDismiss(id: string, durationMs: number, paused: boolean): void {
  const remaining = useRef(durationMs);
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismissToast(id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [id, paused]);
}

export interface ToastViewProps {
  message: string;
  tone?: ToastTone;
  action?: ToastAction | undefined;
  onDismiss: () => void;
  /** Static previews (kitchen sink) must not announce themselves. */
  live?: boolean;
  className?: string | undefined;
}

/** The visual toast; `ToastRegion` positions, stacks and times it. */
export function ToastView({
  message,
  tone = 'info',
  action,
  onDismiss,
  live = true,
  className,
}: ToastViewProps) {
  const { t } = useTranslation();
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div
      role={role}
      className={cn(
        'pointer-events-auto flex w-full max-w-toast items-center gap-2 rounded-md bg-bg-inverse py-1.5 ps-3 pe-1.5 text-sm text-text-inverse shadow-md',
        className,
      )}
    >
      {tone === 'danger' && (
        <CircleAlert
          className="size-4 shrink-0 text-icon-danger"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      )}
      <p className="min-w-0 flex-1 py-1">{message}</p>
      {action && (
        <AriaButton
          onPress={() => {
            action.onAction();
            onDismiss();
          }}
          className="inline-flex h-control-sm shrink-0 cursor-default items-center rounded-sm px-2 text-sm font-semibold text-text-inverse-accent transition-colors duration-(--dur-fast) hover:bg-bg-inverse-muted pressed:bg-bg-inverse-muted"
        >
          {action.label}
        </AriaButton>
      )}
      <IconButton
        icon={X}
        aria-label={t('action.dismiss')}
        variant="ghost-inverse"
        size="sm"
        onPress={onDismiss}
      />
    </div>
  );
}

function ToastItem({ toast: item, paused }: { toast: ToastRecord; paused: boolean }) {
  useAutoDismiss(item.id, item.durationMs, paused);
  return (
    <ToastView
      message={item.message}
      tone={item.tone}
      action={item.action}
      onDismiss={() => dismissToast(item.id)}
      className="animate-toast-in [--popover-enter-offset:var(--space-1)] motion-reduce:animate-fade-in"
    />
  );
}

/** Mount once at the app root. Bottom-left on desktop, full width on mobile. */
export function ToastRegion() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <section
      data-toast-region
      aria-label={t('toast.region')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      className={cn(
        'pointer-events-none fixed z-(--z-toast) flex flex-col gap-2',
        // Above the phone's bottom nav: see `[data-toast-region]` in theme.css.
        'inset-x-3 bottom-3 items-stretch tablet:inset-x-auto tablet:bottom-6 tablet:left-6 tablet:items-start',
        toasts.length === 0 && 'hidden',
      )}
    >
      {toasts.map((item) => (
        <ToastItem key={item.id} toast={item} paused={hovered || focused} />
      ))}
    </section>
  );
}
