import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { listWidthMin, paneWidthMax, paneWidthMin, usePaneStore } from '../../state/pane-store';

export type PaneMode = 'split' | 'overlay' | 'sheet' | 'full';

/** 02 §2 breakpoints and D-29/D-29a: how the pane sits next to the list. */
export function paneMode(options: {
  viewport: number;
  container: number;
  paneWidth: number;
  fullScreen: boolean;
}): PaneMode {
  if (options.viewport < 768) return 'sheet';
  if (options.fullScreen) return 'full';
  if (options.viewport < 1200) return 'overlay';
  return options.container - options.paneWidth < listWidthMin ? 'overlay' : 'split';
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => globalThis.innerWidth ?? 1440);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

const resizeStep = 16;

/**
 * The main area with the detail pane (02 §9.1, D-29/D-29a): a split where the list keeps at
 * least 480 px, an overlay below that (and on tablets), a full-screen sheet on phones, and
 * full screen on request. The split edge is draggable (400–720 px, persisted) and keyboard
 * resizable.
 */
export function SplitView({
  list,
  pane,
  label,
}: {
  list: ReactNode;
  /** The pane content, or null when closed. */
  pane: ReactNode | null;
  /** Accessible name of the pane region. */
  label: string;
}) {
  const { t } = useTranslation('pane');
  const container = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const viewport = useViewportWidth();
  const width = usePaneStore((s) => s.width);
  const fullScreen = usePaneStore((s) => s.fullScreen);
  const [entered, setEntered] = useState(false);
  const open = pane !== null;

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    setContainerWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 180 ms slide in (02 §9.1); --dur-base is 0 under reduced motion.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const mode = paneMode({
    viewport,
    container: containerWidth || viewport,
    paneWidth: width,
    fullScreen,
  });
  const overlayWidth = viewport < 1200 ? undefined : width;

  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    usePaneStore.getState().setWidth(drag.current.width + drag.current.x - event.clientX);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    usePaneStore.getState().setWidth(usePaneStore.getState().width, true);
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const store = usePaneStore.getState();
    const steps: Record<string, number> = {
      ArrowLeft: resizeStep,
      ArrowRight: -resizeStep,
      Home: paneWidthMax - store.width,
      End: paneWidthMin - store.width,
    };
    const delta = steps[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    store.setWidth(store.width + delta, true);
  };

  const paneStyle =
    mode === 'split' || (mode === 'overlay' && overlayWidth !== undefined)
      ? { width: mode === 'split' ? width : overlayWidth }
      : undefined;

  return (
    <div
      ref={container}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-pane-mode={open ? mode : 'closed'}
      data-pane-open={open || undefined}
    >
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto',
          open && mode === 'full' && 'hidden',
        )}
        data-list-column
      >
        {list}
      </div>
      {open && (
        <aside
          data-pane-root
          aria-label={label}
          style={paneStyle}
          className={cn(
            'flex min-h-0 flex-col bg-bg-elevated',
            'transition-transform duration-(--dur-base) ease-standard',
            mode === 'split' && 'relative shrink-0 shadow-pane',
            mode === 'overlay' &&
              'absolute inset-y-0 end-0 z-(--z-pane) w-pane-overlay max-w-full shadow-lg',
            mode === 'full' && 'min-w-0 flex-1',
            mode === 'sheet' && 'fixed inset-0 z-(--z-pane) pb-[env(safe-area-inset-bottom)]',
            !entered &&
              mode !== 'full' &&
              (mode === 'sheet' ? 'translate-y-full' : 'translate-x-full'),
          )}
        >
          {(mode === 'split' || mode === 'overlay') && viewport >= 1200 && (
            // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA).
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={t('resize')}
              aria-valuemin={paneWidthMin}
              aria-valuemax={paneWidthMax}
              aria-valuenow={width}
              data-testid="pane-resize"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onResizeKey}
              className="absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize outline-none hover:bg-border focus-visible:bg-border-focus"
            />
          )}
          {pane}
        </aside>
      )}
    </div>
  );
}
