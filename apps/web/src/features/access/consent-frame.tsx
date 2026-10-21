import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Logo } from '../../ui/logo';

/**
 * The consent pages' frame (11 §3.1: `/device` and `/oauth/consent`): a focused page outside
 * the app frame (like sign-in), with rooster's logo; not a modal (hard rule 9).
 */
export function ConsentFrame({
  children,
  embedded = false,
}: {
  children: ReactNode;
  embedded?: boolean | undefined;
}) {
  return (
    <div
      className={cn('flex flex-col bg-bg-subtle', embedded ? 'rounded-lg' : 'min-h-dvh pt-safe')}
    >
      <main className="flex flex-1 flex-col items-center gap-6 px-3 py-8 tablet:px-6 tablet:py-12">
        <Logo size={32} />
        <div className="flex w-full max-w-pane flex-col gap-6 rounded-lg border border-border bg-bg-elevated px-4 pt-6 shadow-sm tablet:px-8 tablet:pt-8">
          {children}
        </div>
      </main>
    </div>
  );
}

export interface ConsentActionsProps {
  approveLabel: string;
  denyLabel: string;
  /** Which button shows a spinner (the other is disabled meanwhile). */
  pending: 'approve' | 'deny' | null;
  /** Blocks approving (the constraint editor has an issue). */
  blocked: boolean;
  onDeny: () => void;
  'data-testid'?: string;
}

/**
 * Deny and the submitting approve button, sticky at the bottom of the card so they stay in
 * reach on a phone. Deny comes first in the tab order, so tabbing through never lands on
 * approving before the user has passed the choices.
 */
export function ConsentActions({
  approveLabel,
  denyLabel,
  pending,
  blocked,
  onDeny,
  'data-testid': testId,
}: ConsentActionsProps) {
  return (
    <div className="sticky bottom-0 -mx-4 border-t border-border bg-bg-elevated px-4 pt-3 pb-safe tablet:-mx-8 tablet:px-8">
      <div className="flex flex-col-reverse gap-2 pb-3 tablet:flex-row tablet:justify-end tablet:pb-6">
        <Button
          size="lg"
          isLoading={pending === 'deny'}
          isDisabled={pending === 'approve'}
          onPress={onDeny}
          className="w-full tablet:w-auto"
          {...(testId ? { 'data-testid': `${testId}-deny` } : {})}
        >
          {denyLabel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          isLoading={pending === 'approve'}
          isDisabled={blocked || pending === 'deny'}
          className="w-full tablet:w-auto"
          {...(testId ? { 'data-testid': `${testId}-approve` } : {})}
        >
          {approveLabel}
        </Button>
      </div>
    </div>
  );
}

/** "Unverified": a client whose identity rooster couldn't check (11 §3.1, §9.1). */
export function UnverifiedBadge({
  label,
  'data-testid': testId,
}: {
  label: string;
  'data-testid'?: string;
}) {
  return (
    <span
      className="inline-flex h-chip items-center gap-0.5 rounded-xs bg-bg-warning-subtle px-1.5 text-xs font-medium text-text-warning"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <ShieldAlert className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
      {label}
    </span>
  );
}
