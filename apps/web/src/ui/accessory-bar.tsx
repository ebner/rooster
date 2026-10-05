import { Calendar, ChevronDown, CornerDownLeft, Hash, Layers, type LucideIcon } from 'lucide-react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export interface AccessoryBarProps {
  /** The picked date ("Tomorrow"), or nothing for the plain "Date" label. */
  dateLabel?: ReactNode;
  /** The draft's group name. */
  groupLabel: ReactNode;
  onDate: () => void;
  onGroup: () => void;
  onTag: () => void;
  onNext: () => void;
  /** px from the layout viewport's bottom edge: the keyboard's height (`visualViewport`). */
  bottom?: number;
  /** Kitchen sink: in the page flow. */
  isStatic?: boolean;
  className?: string | undefined;
}

/** Taps here must not move focus: the title keeps the caret and the keyboard stays up. */
const keepFocus = (event: PointerEvent | MouseEvent) => event.preventDefault();

function BarButton({
  icon: Icon,
  children,
  onPress,
  emphasis = false,
  trailing,
  label,
  className,
}: {
  icon: LucideIcon;
  children?: ReactNode;
  onPress: () => void;
  emphasis?: boolean;
  trailing?: ReactNode;
  /** Accessible name when the visible text is not enough. */
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onPress}
      className={cn(
        'inline-flex h-hit-touch min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-full px-3 text-sm font-medium',
        'transition-colors duration-(--dur-fast) ease-standard',
        'outline-offset-2 focus-visible:outline-2 focus-visible:outline-border-focus',
        emphasis
          ? 'ms-auto bg-bg-accent text-text-on-accent pressed:bg-bg-accent-hover'
          : 'bg-bg-subtle text-text-secondary pressed:bg-bg-muted',
        className,
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
      {children && <span className="min-w-0 truncate">{children}</span>}
      {trailing}
    </button>
  );
}

/**
 * The bar above the phone's keyboard while a new task is typed (02 §13.3):
 * [📅 Date] [▤ Group ▾] [# Tag] [↵ Next]. It rides on the keyboard through `visualViewport`,
 * and its buttons never take focus from the title.
 */
export function AccessoryBar({
  dateLabel,
  groupLabel,
  onDate,
  onGroup,
  onTag,
  onNext,
  bottom = 0,
  isStatic = false,
  className,
}: AccessoryBarProps) {
  const { t } = useTranslation('mobile');
  return (
    <div
      role="toolbar"
      aria-label={t('accessory.label')}
      data-testid="accessory-bar"
      style={isStatic ? undefined : { bottom }}
      className={cn(
        'flex h-accessory-bar w-full items-center gap-2 border-t border-border bg-bg-elevated',
        'px-safe-2',
        !isStatic && 'fixed inset-x-0 z-(--z-bulk-bar)',
        className,
      )}
    >
      <BarButton icon={Calendar} onPress={onDate}>
        {dateLabel ?? t('accessory.date')}
      </BarButton>
      <BarButton
        icon={Layers}
        onPress={onGroup}
        className="shrink"
        label={t('accessory.group', { name: typeof groupLabel === 'string' ? groupLabel : '' })}
        trailing={
          <ChevronDown className="size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
        }
      >
        {groupLabel}
      </BarButton>
      <BarButton icon={Hash} onPress={onTag} label={t('accessory.tag')} />
      <BarButton icon={CornerDownLeft} onPress={onNext} emphasis>
        {t('accessory.next')}
      </BarButton>
    </div>
  );
}
