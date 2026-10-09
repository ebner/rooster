import { lazyWithPreload } from '../../lib/lazy';

/** 10 §4: the assignee picker loads on first open (and at idle); see `lib/lazy.ts`. */
export const LazyAssigneePicker = lazyWithPreload(() =>
  import('./assignee-picker').then((m) => m.AssigneePicker),
);
