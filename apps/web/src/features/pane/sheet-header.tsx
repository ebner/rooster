import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import { type ReactNode, type RefObject, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SheetHandle } from '../../ui/bottom-sheet';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuPopover, MenuTrigger } from '../../ui/menu';
import { useDragDismiss } from '../../ui/use-drag-dismiss';

export interface SheetHeaderProps {
  /** ‹ back, a swipe down from here, and the system back all close the sheet. */
  onBack: () => void;
  /** The ⋯ menu's items. */
  menu?: ReactNode;
  /** The element that moves with the finger (the sheet); defaults to `[data-pane-root]`. */
  surfaceRef?: RefObject<HTMLElement | null>;
}

/**
 * The detail sheet's header on phones (03 §3.11): 56 px with ‹ back, a centred 36 × 4 drag
 * handle and the actions ⋯. Dragging the header down follows the finger and closes the sheet
 * past a quarter of its height or on a flick (02 §13.4).
 */
export function SheetHeader({ onBack, menu, surfaceRef }: SheetHeaderProps) {
  const { t } = useTranslation('mobile');
  const { t: tPane } = useTranslation('pane');
  const header = useRef<HTMLDivElement>(null);
  const fallback = {
    get current() {
      return header.current?.closest<HTMLElement>('[data-pane-root]') ?? null;
    },
  };
  const drag = useDragDismiss(surfaceRef ?? fallback, onBack);
  return (
    <div
      ref={header}
      {...drag}
      data-testid="sheet-header"
      className="relative flex h-sheet-header shrink-0 touch-none items-center justify-between border-b border-border px-1"
    >
      <IconButton icon={ChevronLeft} aria-label={t('sheet.back')} size="lg" onPress={onBack} />
      <SheetHandle className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2" />
      {menu && (
        <MenuTrigger>
          <IconButton icon={MoreHorizontal} aria-label={tPane('toolbar.more')} size="lg" />
          <MenuPopover placement="bottom end" className="min-w-48">
            <Menu aria-label={tPane('toolbar.more')}>{menu}</Menu>
          </MenuPopover>
        </MenuTrigger>
      )}
    </div>
  );
}
