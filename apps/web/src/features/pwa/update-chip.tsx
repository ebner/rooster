import { CircleArrowUp, RefreshCw } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';

export interface UpdateChipProps {
  /** Reload was asked for and waits for the outbox or the editor. */
  deferred?: boolean;
  onPress: () => void;
  className?: string | undefined;
  /** Kitchen-sink only: render a state statically ("hover", "focus", "pressed"). */
  'data-force'?: string;
}

/**
 * The header's persistent "Update" chip next to the sync pill (FR-PWA-6): it stays while a new
 * version waits, after the toast is gone. Coarse pointers get a 44 px hit area, like buttons.
 */
export function UpdateChip({
  deferred = false,
  onPress,
  className,
  'data-force': force,
}: UpdateChipProps) {
  const { t } = useTranslation('pwa');
  const Icon = deferred ? RefreshCw : CircleArrowUp;
  return (
    <AriaButton
      onPress={onPress}
      data-force={force}
      data-update-chip={deferred ? 'deferred' : 'available'}
      {...(deferred ? {} : { 'aria-label': t('update.chipLabel') })}
      className={cn(
        'relative inline-flex h-pill shrink-0 cursor-default items-center gap-1.5 rounded-full bg-bg-info-subtle px-2 text-xs font-medium whitespace-nowrap text-text-info select-none',
        'underline-offset-2 hover:underline pressed:underline',
        'outline-none focus-ring:outline-2 focus-ring:outline-offset-2 focus-ring:outline-border-focus',
        'pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2',
        'pointer-coarse:after:min-h-hit-touch pointer-coarse:after:min-w-hit-touch',
        'pointer-coarse:after:size-full pointer-coarse:after:-translate-1/2',
        className,
      )}
    >
      <Icon
        className={cn('size-3 shrink-0', deferred && 'motion-safe:animate-spin')}
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <span>{deferred ? t('update.chipDeferred') : t('update.chip')}</span>
    </AriaButton>
  );
}
