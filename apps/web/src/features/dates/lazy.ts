import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: the date picker loads on first open (and at idle); see `lib/lazy.ts`. */
export const LazyDatePopover = lazyWithPreload(() =>
  import('./date-popover').then((m) => m.DatePopover),
);
export const LazyDatePanel = lazyWithPreload(() =>
  import('./date-popover').then((m) => m.DatePanel),
);
