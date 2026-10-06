import type { Tag } from '@rooster/core/schemas';

export interface TagOption {
  kind: 'tag' | 'create';
  id: string;
  name: string;
  tag?: Tag;
}

/** Tags matching `query` (prefix matches first), plus "Create …" when no tag has that name. */
export function tagOptions(tags: readonly Tag[], query: string, allowCreate = true): TagOption[] {
  const q = query.trim().toLocaleLowerCase();
  const matches = tags
    .filter((t) => t.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const pa = a.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })
    .map((tag): TagOption => ({ kind: 'tag', id: tag.id, name: tag.name, tag }));
  const exact = tags.some((t) => t.name.toLocaleLowerCase() === q);
  if (allowCreate && q !== '' && !exact) {
    matches.push({ kind: 'create', id: '__create', name: query.trim().slice(0, 40) });
  }
  return matches;
}
