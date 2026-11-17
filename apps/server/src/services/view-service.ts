import type {
  SavedView,
  SavedViewCreate,
  SavedViewListQuery,
  SavedViewMove,
  SavedViewPatch,
  SavedViewTasks,
  SavedViewTasksQuery,
} from '@rooster/core/schemas';
import type { Actor, OpMeta, ServiceDeps } from './context.ts';

/**
 * Phase 13 (ADR 0073 B): views, saved queries in one org (`saved_view`, `saved_view_pref`).
 * Reading needs `tasks:read`, managing `groups:write` (11 §2); a private view is its creator's
 * only (anyone else gets `404`). Contract stub: the implementation follows.
 */
export class ViewService {
  constructor(private readonly deps: ServiceDeps) {}

  list(_actor: Actor, _orgRef: string, _query: SavedViewListQuery): SavedView[] {
    return this.todo();
  }

  create(_actor: Actor, _orgRef: string, _input: SavedViewCreate, _meta?: OpMeta): SavedView {
    return this.todo();
  }

  update(_actor: Actor, _viewId: string, _patch: SavedViewPatch, _meta?: OpMeta): SavedView {
    return this.todo();
  }

  remove(_actor: Actor, _viewId: string, _meta?: OpMeta): void {
    this.todo();
  }

  move(_actor: Actor, _viewId: string, _intent: SavedViewMove, _meta?: OpMeta): SavedView {
    return this.todo();
  }

  setArchived(_actor: Actor, _viewId: string, _archived: boolean, _meta?: OpMeta): SavedView {
    return this.todo();
  }

  tasks(_actor: Actor, _viewId: string, _query: SavedViewTasksQuery): SavedViewTasks {
    return this.todo();
  }

  private todo(): never {
    void this.deps;
    throw new Error('ViewService: not implemented yet');
  }
}
