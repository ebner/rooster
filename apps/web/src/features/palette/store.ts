import { create } from 'zustand';

export type PaletteMode = 'command' | 'search';

export interface OpenPaletteOptions {
  query?: string;
  mode?: PaletteMode;
}

/**
 * The palette's open state (02 §12). Kept out of the lazy palette chunk: the shell's key
 * handlers, the sidebar's Search item and the phone's Search tab open it before it has loaded.
 */
export interface PaletteState {
  open: boolean;
  /** Set on the first open; the lazy palette stays mounted (and warm) afterwards. */
  loaded: boolean;
  /** The input's text when it opens (`>` for actions only). */
  initialQuery: string;
  /** `search` (`/`, the Search tab): tasks only until the query asks for actions with `>`. */
  mode: PaletteMode;
  /** Bumped on every open, so the panel resets its input and step. */
  session: number;
}

export const usePaletteStore = create<PaletteState>()(() => ({
  open: false,
  loaded: false,
  initialQuery: '',
  mode: 'command',
  session: 0,
}));

/** The element focused before the palette opened; focus goes back there on close (02 §12). */
let returnFocus: Element | null = null;

export function paletteReturnFocus(): Element | null {
  return returnFocus;
}

export function openPalette({ query = '', mode = 'command' }: OpenPaletteOptions = {}): void {
  const active = globalThis.document?.activeElement ?? null;
  // Re-opening from inside the palette keeps the original return target.
  if (!usePaletteStore.getState().open) {
    returnFocus = active && active !== document.body ? active : null;
  }
  usePaletteStore.setState((s) => ({
    open: true,
    loaded: true,
    initialQuery: query,
    mode,
    session: s.session + 1,
  }));
}

/** Closes the palette; `restoreFocus` false leaves focus where the action put it. */
export function closePalette(restoreFocus = true): void {
  if (!usePaletteStore.getState().open) return;
  usePaletteStore.setState({ open: false });
  const target = returnFocus;
  returnFocus = null;
  if (restoreFocus && target instanceof HTMLElement && target.isConnected) {
    target.focus({ preventScroll: true });
  }
}

export function togglePalette(options: OpenPaletteOptions = {}): void {
  if (usePaletteStore.getState().open) closePalette();
  else openPalette(options);
}
