import { Check, type LucideIcon } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';
import { useDragDismiss } from './use-drag-dismiss';

/** The 36 × 4 grab handle centred in a sheet's top edge (03 §3.11). Decorative. */
export function SheetHandle({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block h-(--h-sheet-handle) w-sheet-handle rounded-full bg-border-strong',
        className,
      )}
    />
  );
}

export const bottomSheetSurface =
  'flex max-h-sheet w-full flex-col rounded-t-lg bg-bg-elevated pb-safe text-text shadow-lg outline-none';

export interface BottomSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The visible heading and the dialog's accessible name. */
  title: string;
  /** A muted line under the title, e.g. the task the sheet acts on. */
  description?: ReactNode;
  children: ReactNode;
  /** Kitchen sink: render the surface in the page flow, without overlay or focus trap. */
  isStatic?: boolean;
  className?: string | undefined;
}

/**
 * The mobile bottom sheet (03 §3.11): top radius lg, at most 70 % of the screen, a scrim,
 * and a 250 ms slide up (instant under reduced motion). It replaces anchored popovers on
 * phones: quick date, group and tag pickers, the org switcher. Esc, a tap on the scrim or a
 * swipe down from the handle closes it; focus is trapped while open and restored after.
 */
export function BottomSheet({
  isOpen,
  onOpenChange,
  title,
  description,
  children,
  isStatic = false,
  className,
}: BottomSheetProps) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useDragDismiss(surface, () => onOpenChange(false));
  const { t } = useTranslation('mobile');

  const body = (
    <>
      <div
        {...(isStatic ? {} : drag)}
        className="flex shrink-0 touch-none flex-col items-center gap-3 px-4 pt-2 pb-3"
        data-sheet-drag
      >
        <SheetHandle />
        <div className="flex w-full flex-col gap-0.5">
          <Heading slot="title" className="text-group text-text">
            {title}
          </Heading>
          {description && <div className="truncate text-sm text-text-secondary">{description}</div>}
        </div>
      </div>
      <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-2 pb-2">
        {children}
      </div>
      {!isStatic && (
        <AriaButton slot="close" className="sr-only">
          {t('sheet.close')}
        </AriaButton>
      )}
    </>
  );

  if (isStatic) {
    return (
      <section aria-label={title} className={cn(bottomSheetSurface, 'max-h-none', className)}>
        {body}
      </section>
    );
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className={cn(
        'fixed inset-0 z-(--z-popover) flex items-end bg-overlay',
        'data-entering:animate-fade-in data-exiting:animate-fade-out',
      )}
    >
      <Modal
        ref={surface}
        className={cn(
          bottomSheetSurface,
          'data-entering:animate-sheet-in data-exiting:animate-sheet-out',
          className,
        )}
      >
        <Dialog className="flex min-h-0 flex-1 flex-col outline-none" data-testid="bottom-sheet">
          {body}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export interface SheetOptionProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  icon?: LucideIcon | undefined;
  /** Rendered instead of `icon`, e.g. a tag dot or an avatar. */
  leading?: ReactNode;
  label: ReactNode;
  /** Right-aligned muted text, e.g. the date a quick option resolves to. */
  detail?: ReactNode;
  /** Shows a check (current group, applied tag); exposed as `aria-pressed`/`aria-current`. */
  checked?: boolean | undefined;
  tone?: 'default' | 'danger';
  className?: string | undefined;
  'data-force'?: string;
}

/** A 48 px sheet row (02 §13.4: touch targets ≥ 44 px): icon · label · detail · check. */
export function SheetOption({
  icon: Icon,
  leading,
  label,
  detail,
  checked,
  tone = 'default',
  className,
  ...props
}: SheetOptionProps) {
  return (
    <AriaButton
      {...props}
      className={cn(
        'flex h-property-row-mobile w-full shrink-0 cursor-default items-center gap-3 rounded-sm px-3 text-start text-md',
        'transition-colors duration-(--dur-fast) hover:bg-bg-subtle pressed:bg-bg-muted',
        'outline-none focus-ring:outline-2 focus-ring:-outline-offset-2 focus-ring:outline-border-focus',
        'data-disabled:text-text-disabled',
        tone === 'danger' ? 'text-text-danger' : 'text-text',
        className,
      )}
    >
      {leading ??
        (Icon && (
          <Icon
            className={cn('size-5 shrink-0', tone === 'danger' ? '' : 'text-text-secondary')}
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        ))}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="shrink-0 text-sm text-text-muted tabular-nums">{detail}</span>}
      {checked !== undefined && (
        <Check
          className={cn('size-5 shrink-0 text-text-accent', !checked && 'invisible')}
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      )}
    </AriaButton>
  );
}
