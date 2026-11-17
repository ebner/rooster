import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: the move-to-organisation picker loads on first open (and at idle). */
export const LazyMoveOrgPopover = lazyWithPreload(() =>
  import('./move-org-picker').then((m) => m.MoveOrgPopover),
);
export const LazyMoveOrgSheet = lazyWithPreload(() =>
  import('./move-org-picker').then((m) => m.MoveOrgSheet),
);
