import type { Tag } from '@rooster/core/schemas';
import { create } from 'zustand';

/**
 * The current org's tags by id, mirrored from `['tags', orgId]` by the list view, so each row
 * subscribes to one stable map (a context value would re-render every row on any change).
 */
export const useTagsStore = create<{ byId: Readonly<Record<string, Tag>> }>()(() => ({
  byId: {},
}));

export function setTags(tags: readonly Tag[]): void {
  const current = useTagsStore.getState().byId;
  const same =
    Object.keys(current).length === tags.length && tags.every((t) => current[t.id] === t);
  if (same) return;
  useTagsStore.setState({ byId: Object.fromEntries(tags.map((t) => [t.id, t])) });
}
