import { create } from 'zustand';
import { uiScale } from '../lib/ui-scale';

/**
 * 02 §9.1 / D-29: the split pane is 520 px by default, resizable from 400 to 720 px. These are
 * px at UI scale 1, like the tokens they mirror (--w-pane*); multiply by `uiScale()`.
 */
export const paneWidthDefault = 520;
export const paneWidthMin = 400;
export const paneWidthMax = 720;
/** D-29a: below this list width (px at scale 1) the pane overlays the list instead of splitting. */
export const listWidthMin = 480;

const widthKey = 'rooster.pane.width';

/** Clamps a rendered pane width (CSS px) to the 400–720 range at the given UI scale. */
export function clampPaneWidth(width: number, scale = 1): number {
  return Math.round(Math.min(paneWidthMax * scale, Math.max(paneWidthMin * scale, width)));
}

/**
 * The pane width to render: the user's width when they resized it, the default otherwise,
 * clamped to the range at the current scale so a width set on a smaller scale still fits.
 */
export function effectivePaneWidth(width: number | null, scale: number): number {
  return clampPaneWidth(width ?? paneWidthDefault * scale, scale);
}

function readWidth(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(widthKey));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** What the pane should focus once it renders the task (O / Tab+Enter, Tab+R). */
/** `assignee` opens the pane's assignee picker; `comment` focuses the composer (P6). */
export type PaneFocusTarget =
  | 'title'
  | 'description'
  | 'subtask'
  | 'tags'
  | 'date'
  | 'assignee'
  | 'comment';

export interface PaneState {
  /** Full screen (Tab+X, ⤢): the pane takes the main area, the sidebar stays. */
  fullScreen: boolean;
  /** The width the user resized the pane to (CSS px), or null for the scaled default. */
  width: number | null;
  /** A pending focus request; `seq` makes repeated requests distinct. */
  focus: { target: PaneFocusTarget; seq: number } | null;
  /** The task the pane last showed, so a group header selection keeps it (02 §3.2). */
  lastTaskId: string | null;
}

export interface PaneActions {
  setFullScreen: (fullScreen: boolean) => void;
  setWidth: (width: number, persist?: boolean) => void;
  requestFocus: (target: PaneFocusTarget) => void;
  clearFocus: () => void;
}

let focusSeq = 0;

/** 04 §5.2 `paneStore`. Whether the pane is open, and for which task, lives in the URL. */
export const usePaneStore = create<PaneState & PaneActions>()((set) => ({
  fullScreen: false,
  width: readWidth(),
  focus: null,
  lastTaskId: null,
  setFullScreen: (fullScreen) => set({ fullScreen }),
  setWidth: (width, persist = false) => {
    const next = clampPaneWidth(width, uiScale());
    set({ width: next });
    if (!persist) return;
    try {
      globalThis.localStorage?.setItem(widthKey, String(next));
    } catch {
      // Storage blocked: the width holds for this session.
    }
  },
  requestFocus: (target) => {
    focusSeq += 1;
    set({ focus: { target, seq: focusSeq } });
  },
  clearFocus: () => set({ focus: null }),
}));
