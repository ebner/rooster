import type { Attachment } from '@rooster/core/schemas';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { matches, primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { detectPlatform } from '../../lib/platform';
import { buttonVariants, iconStrokeWidth, Spinner } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { stepIndex } from './model';

export interface LightboxProps {
  /** The task's raster images, in grid order. */
  images: readonly Attachment[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** The full image (`?inline=1`). */
  src: (attachment: Attachment) => string;
  downloadHref: (attachment: Attachment) => string;
  /** Kitchen sink: render the surface in the page flow, without the overlay or focus trap. */
  isStatic?: boolean;
}

/** A horizontal swipe longer than this (px) on a touch screen goes to the next or previous image. */
const swipeMinPx = 48;

/**
 * The image lightbox (FR-ATT-2, ADR 0049 §3.8): one raster image at a time over the app, with
 * ←/→ (and swipes on phones) between the task's images, Esc to close, and a download button.
 * Focus stays inside while it is open; the caller returns it to the thumbnail.
 */
export function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
  src,
  downloadHref,
  isStatic = false,
}: LightboxProps) {
  const { t } = useTranslation('attachments');
  const current = images[index];
  if (!current) return null;
  const label = t('lightbox.label', {
    name: current.filename,
    index: index + 1,
    total: images.length,
  });
  const body = (
    <LightboxBody
      images={images}
      index={index}
      current={current}
      onIndexChange={onIndexChange}
      onClose={onClose}
      src={src}
      downloadHref={downloadHref}
      modal={!isStatic}
    />
  );
  if (isStatic) {
    return (
      <section aria-label={label} className={cn(surfaceClass, 'aspect-video w-full')}>
        {body}
      </section>
    );
  }
  return (
    <ModalOverlay
      isOpen
      isDismissable={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="fixed inset-0 z-(--z-palette) data-entering:animate-fade-in data-exiting:animate-fade-out"
    >
      <Modal className={cn(surfaceClass, 'fixed inset-0')}>
        <Dialog
          aria-label={label}
          className="flex min-h-0 flex-1 flex-col outline-none"
          data-testid="lightbox"
        >
          {body}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const surfaceClass = 'flex flex-col bg-bg-inverse pt-safe pb-safe text-text-inverse';

function LightboxBody({
  images,
  index,
  current,
  onIndexChange,
  onClose,
  src,
  downloadHref,
  modal,
}: {
  /** Over the app (not the kitchen sink's static preview): ←/→ work wherever focus is. */
  modal: boolean;
  images: readonly Attachment[];
  index: number;
  current: Attachment;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  src: (attachment: Attachment) => string;
  downloadHref: (attachment: Attachment) => string;
}) {
  const { t } = useTranslation('attachments');
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const total = images.length;
  const step = (delta: number) => {
    if (total > 1) onIndexChange(stepIndex(index, delta, total));
  };

  // Each image starts loading afresh; its neighbours are fetched ahead, so ←/→ feels instant.
  useEffect(() => {
    setState('loading');
    if (total < 2) return;
    for (const delta of [1, -1]) {
      const neighbour = images[stepIndex(index, delta, total)];
      if (neighbour) new Image().src = src(neighbour);
    }
  }, [current.id]);

  // ←/→ wherever focus is in the lightbox (the dialog itself, or one of its buttons).
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!modal) return;
    const platform = detectPlatform();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (matches(event, 'lightboxPrevious', platform)) stepRef.current(-1);
      else if (matches(event, 'lightboxNext', platform)) stepRef.current(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [modal]);
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') swipe.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= swipeMinPx && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-toolbar shrink-0 items-center gap-2 ps-4 pe-2">
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
          <span className="truncate font-medium" data-testid="lightbox-name">
            {current.filename}
          </span>
          {total > 1 && (
            <span className="shrink-0 text-text-inverse-muted tabular-nums">
              {t('lightbox.position', { index: index + 1, total })}
            </span>
          )}
        </h2>
        <a
          href={downloadHref(current)}
          download={current.filename}
          className={cn(
            buttonVariants({ variant: 'ghost-inverse', size: 'md' }),
            'outline-none focus-visible:outline-2 focus-visible:outline-border-focus',
          )}
          data-testid="lightbox-download"
        >
          <Download className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          <span className="max-tablet:sr-only">{t('lightbox.download')}</span>
        </a>
        <IconButton
          icon={X}
          variant="ghost-inverse"
          aria-label={t('lightbox.close')}
          shortcut={primaryKeys('lightboxClose')}
          onPress={onClose}
          data-testid="lightbox-close"
        />
      </header>
      <div
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center px-4 pb-4 select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null;
        }}
      >
        {state === 'loading' && (
          <span className="absolute inset-0 flex items-center justify-center text-text-inverse-muted">
            <Spinner />
          </span>
        )}
        {state === 'failed' ? (
          <p className="max-w-pane-min text-center text-sm text-text-inverse-muted" role="alert">
            {t('lightbox.loadFailed')}
          </p>
        ) : (
          <img
            key={current.id}
            src={src(current)}
            alt={current.filename}
            draggable={false}
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
            className={cn(
              'max-h-full max-w-full rounded-sm object-contain',
              state === 'loading' && 'opacity-0',
            )}
            data-testid="lightbox-image"
          />
        )}
        {total > 1 && (
          <>
            <NavButton side="start">
              <IconButton
                icon={ChevronLeft}
                variant="ghost-inverse"
                size="lg"
                aria-label={t('lightbox.previous')}
                shortcut={primaryKeys('lightboxPrevious')}
                onPress={() => step(-1)}
                data-testid="lightbox-previous"
              />
            </NavButton>
            <NavButton side="end">
              <IconButton
                icon={ChevronRight}
                variant="ghost-inverse"
                size="lg"
                aria-label={t('lightbox.next')}
                shortcut={primaryKeys('lightboxNext')}
                onPress={() => step(1)}
                data-testid="lightbox-next"
              />
            </NavButton>
          </>
        )}
      </div>
    </div>
  );
}

function NavButton({ side, children }: { side: 'start' | 'end'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-full bg-bg-inverse',
        side === 'start' ? 'start-2' : 'end-2',
      )}
    >
      {children}
    </div>
  );
}
