import type { PaneFocusTarget } from '../../state/pane-store';

/**
 * How a list drives the detail pane (02 §9.1). The route implements it on top of the URL
 * (`/o/:orgSlug/t/:taskId`), so the list never navigates by itself.
 */
export interface PaneControls {
  /** The task the pane shows, or null when closed. */
  taskId: () => string | null;
  /**
   * Opens (or switches) the pane. `focus` moves focus into the pane; without it focus stays
   * where it is (a row click, Space peek, following the selection).
   */
  open: (taskId: string, focus?: PaneFocusTarget | null) => void;
  close: () => void;
  toggleFullScreen: () => void;
}
