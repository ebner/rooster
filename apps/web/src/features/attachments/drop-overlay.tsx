import { Upload } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';

export interface DropRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const surface =
  'flex flex-col items-center justify-center gap-2 rounded-md bg-bg-accent-subtle text-text outline-1 -outline-offset-1 outline-drop-target-outline';

function Content() {
  const { t } = useTranslation('attachments');
  return (
    <>
      <Upload className="size-6 text-text-accent" strokeWidth={iconStrokeWidth} aria-hidden />
      <span className="text-md font-medium">{t('dropHere')}</span>
      <span className="text-sm text-text-secondary">{t('dropHint')}</span>
    </>
  );
}

/**
 * Covers the pane while files are dragged over it (02 §9.2 item 7: the whole pane is the drop
 * zone). It never takes pointer events, so the drag keeps reaching the pane underneath.
 */
export function DropOverlay({ rect }: { rect: DropRect }) {
  return createPortal(
    <div
      aria-hidden
      className={cn(surface, 'pointer-events-none fixed z-(--z-popover) animate-fade-in')}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      data-testid="attachment-drop-overlay"
    >
      <Content />
    </div>,
    document.body,
  );
}

/** Kitchen sink: the overlay in the page flow. */
export function DropOverlayPreview({ className }: { className?: string | undefined }) {
  return (
    <div className={cn(surface, 'aspect-video w-full', className)}>
      <Content />
    </div>
  );
}
