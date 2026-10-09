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
import { uiScale } from '../../lib/ui-scale';
import {
  effectivePaneWidth,
  listWidthMin,
  paneWidthMax,
  paneWidthMin,
  usePaneStore,
} from '../../state/pane-store';

export type PaneMode = 'split' | 'overlay' | 'sheet' | 'full';

/**
 * 02 §2 breakpoints and D-29/D-29a: how the pane sits next to the list. Widths are CSS px;
 * `listMin` is the D-29a minimum at the current UI scale (480 px at scale 1).
 */
export function paneMode(options: {
  viewport: number;
  container: number;
  paneWidth: number;
  fullScreen: boolean;
  listMin?: number;
}): PaneMode {
  if (options.viewport < 768) return 'sheet';
  if (options.fullScreen) return 'full';
  if (options.viewport < 1200) return 'overlay';
  const listMin = options.listMin ?? listWidthMin;
  return options.container - options.paneWidth < listMin ? 'overlay' : 'split';
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
 * resizable. All of these are px at UI scale 1 and grow with the root font size on desktop.
 */
export function SplitView({
  list,
  pane,
  label,
  onDismiss,
}: {
  list: ReactNode;
  /** The pane content, or null when closed. */
  pane: ReactNode | null;
  /** Accessible name of the pane region. */
  label: string;
  /** A tap on the tablet overlay's scrim (02 §2). */
  onDismiss?: (() => void) | undefined;
}) {
  const { t } = useTranslation('pane');
  const container = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const viewport = useViewportWidth();
  const storedWidth = usePaneStore((s) => s.width);
  // The root font size follows the viewport breakpoints, so reading it on every render (the
  // viewport hook re-renders on resize) keeps the pane in step with the tokens.
  const scale = uiScale();
  const width = effectivePaneWidth(storedWidth, scale);
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
    listMin: listWidthMin * scale,
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
    const resized = usePaneStore.getState().width;
    if (resized !== null) usePaneStore.getState().setWidth(resized, true);
  };
  const minWidth = Math.round(paneWidthMin * scale);
  const maxWidth = Math.round(paneWidthMax * scale);
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const targets: Record<string, number> = {
      ArrowLeft: width + resizeStep,
      ArrowRight: width - resizeStep,
      Home: maxWidth,
      End: minWidth,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    usePaneStore.getState().setWidth(target, true);
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
      {open && mode === 'overlay' && viewport < 1200 && (
        // Tablets (02 §2): the overlay pane dims the list; a tap outside closes it.
        <div
          aria-hidden
          data-testid="pane-scrim"
          onClick={onDismiss}
          className="absolute inset-0 z-(--z-pane) bg-overlay animate-fade-in"
        />
      )}
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
            // Phones (02 §13.4): a full-screen sheet sliding up over 250 ms.
            mode === 'sheet' && 'fixed inset-0 z-(--z-pane) pt-safe duration-(--dur-slow)',
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
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
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
