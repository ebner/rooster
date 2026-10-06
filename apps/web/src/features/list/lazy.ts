import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: list popovers load on first open (and at idle); see `lib/lazy.ts`. */
export const LazyTagPicker = lazyWithPreload(() =>
  import('../tags/tag-picker').then((m) => m.TagPicker),
);
export const LazyMoveToPopover = lazyWithPreload(() =>
  import('./move-to-popover').then((m) => m.MoveToPopover),
);
export const LazyGroupDeletePopover = lazyWithPreload(() =>
  import('./group-delete-popover').then((m) => m.GroupDeletePopover),
);
