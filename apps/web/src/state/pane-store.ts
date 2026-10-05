import { create } from 'zustand';

/** 02 §9.1 / D-29: the split pane is 520 px by default, resizable from 400 to 720 px. */
export const paneWidthDefault = 520;
export const paneWidthMin = 400;
export const paneWidthMax = 720;
/** D-29a: below this list width the pane overlays the list instead of splitting. */
export const listWidthMin = 480;

const widthKey = 'rooster.pane.width';

export function clampPaneWidth(width: number): number {
  return Math.round(Math.min(paneWidthMax, Math.max(paneWidthMin, width)));
}

function readWidth(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(widthKey));
    return Number.isFinite(stored) && stored > 0 ? clampPaneWidth(stored) : paneWidthDefault;
  } catch {
    return paneWidthDefault;
  }
}

/** What the pane should focus once it renders the task (O / Tab+Enter, Tab+R). */
export type PaneFocusTarget = 'title' | 'description' | 'subtask' | 'tags' | 'date';

export interface PaneState {
  /** Full screen (Tab+X, ⤢): the pane takes the main area, the sidebar stays. */
  fullScreen: boolean;
  width: number;
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
    const next = clampPaneWidth(width);
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
