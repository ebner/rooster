import { lazyWithPreload } from '../../lib/lazy';

/**
 * 10 §4: a view's screen (header, chips, sheet, rows) is its own chunk, off the initial route;
 * the tasks screen warms it at idle.
 */
export const LazySavedViewContent = lazyWithPreload(() =>
  import('./saved-view-screen').then((m) => m.SavedViewContent),
);
