import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: the feed (Markdown-light renderer, grouping) loads with the first opened pane. */
export const LazyPaneActivity = lazyWithPreload(() =>
  import('./pane-activity').then((m) => m.PaneActivity),
);
