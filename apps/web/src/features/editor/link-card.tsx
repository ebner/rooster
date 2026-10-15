import { ExternalLink, Pencil, Unlink } from 'lucide-react';
import type { Ref } from 'react';
import { Toolbar } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { buttonVariants, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { popoverSurface } from '../../ui/popover';
import { isAllowedLinkHref } from './link';

/** The address as people read it: no `https://`, `mailto:` or trailing slash. */
export function displayHref(href: string): string {
  return href.replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '') || href;
}

export interface LinkCardProps {
  href: string;
  onEdit: () => void;
  onRemove: () => void;
  ref?: Ref<HTMLDivElement> | undefined;
  className?: string | undefined;
}

/**
 * What a tap on a description link shows on touch screens (ADR 0062): the address, which
 * opens the link in a new tab, and Edit and Remove. The buttons keep the focus in the text,
 * so the keyboard stays up.
 */
export function LinkCard({ href, onEdit, onRemove, ref, className }: LinkCardProps) {
  const { t } = useTranslation('editor');
  const address = displayHref(href);
  return (
    <Toolbar
      ref={ref}
      aria-label={t('toolbar.link')}
      data-testid="link-card"
      className={cn(popoverSurface, 'flex max-w-date-popover items-center gap-0.5', className)}
    >
      {isAllowedLinkHref(href) ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={t('link.openAddress', { address })}
          title={href}
          // Keeps the focus (and the bubble menu) in the text until the click lands.
          onMouseDown={(event) => event.preventDefault()}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-w-0 text-text-info')}
        >
          <ExternalLink className="size-4 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
          <span className="truncate">{address}</span>
        </a>
      ) : (
        <span className="min-w-0 truncate px-2 text-sm text-text-secondary">{address}</span>
      )}
      <IconButton
        size="sm"
        icon={Pencil}
        aria-label={t('link.edit')}
        preventFocusOnPress
        onPress={onEdit}
      />
      <IconButton
        size="sm"
        icon={Unlink}
        aria-label={t('link.remove')}
        preventFocusOnPress
        onPress={onRemove}
      />
    </Toolbar>
  );
}
