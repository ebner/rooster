import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  type ScreenReaderInstructions,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isProjectView } from '@rooster/core/saved-views';
import type { SavedView, SavedViewMove } from '@rooster/core/schemas';
import { GripVertical, Hash, Plus, Search } from 'lucide-react';
import { type KeyboardEventHandler, memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { toast } from '../../ui/toast';
import { paths } from './paths';
import { moveIntent } from './reorder';
import { SidebarItem } from './sidebar-item';

export interface SidebarSavedViewsProps {
  orgName: string;
  /** The org's URL slug (`orgUrlSlug`). */
  slug: string;
  /** The live views in the viewer's own order (empty: only "+ New view"). */
  views: readonly SavedView[];
  /** The view shown (or under the pane), `'new'` for "+ New view", else null. */
  activeViewId: string | null;
  /** Moves a view in the viewer's own order; a rejection shows the save error. */
  onMove: (id: string, intent: SavedViewMove) => unknown;
  rail?: boolean;
  /** Kitchen sink: render the first view lifted. */
  forceDragging?: boolean;
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * The org's views under Everyone's tasks (02 §2, ADR 0073 B9): shared and private ones mixed,
 * in the viewer's own order, each with its open count; `#` for a project view (one tag), ⌕
 * otherwise; then "+ New view". Without views only that entry shows, muted: the part costs one
 * quiet row until it is used. Reordering works like the org sections: the whole row is a
 * pointer drag source, and the grip lifts it from the keyboard (Space, arrows, Space) with
 * live announcements. Drops show at once and settle when the server's order comes back.
 *
 * Memoised: the props change only with the views query or the route, never with a list op.
 */
export const SidebarSavedViews = memo(function SidebarSavedViews({
  orgName,
  slug,
  views,
  activeViewId,
  onMove,
  rail = false,
  forceDragging = false,
}: SidebarSavedViewsProps) {
  const { t } = useTranslation('shell');
  // A drop shows at once; it holds until the query delivers a new list (the server's order).
  const [pending, setPending] = useState<{ base: readonly SavedView[]; ids: string[] } | null>(
    null,
  );
  const ordered = useMemo(() => {
    if (!pending || pending.base !== views) return views;
    const byId = new Map(views.map((v) => [v.id, v]));
    return pending.ids.flatMap((id) => byId.get(id) ?? []);
  }, [views, pending]);
  const ids = useMemo(() => ordered.map((v) => v.id), [ordered]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (id: string | number) => ordered.find((v) => v.id === id)?.name ?? '';
  const positionOf = (id: string | number) => ids.indexOf(String(id)) + 1;
  const total = ids.length;
  const lastOver = useRef<string | number | null>(null);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      lastOver.current = active.id;
      return t('dnd.pickedUp', { name: nameOf(active.id), position: positionOf(active.id), total });
    },
    onDragOver: ({ active, over }) => {
      if (!over || over.id === lastOver.current) return undefined;
      lastOver.current = over.id;
      return t('dnd.over', { name: nameOf(active.id), position: positionOf(over.id), total });
    },
    onDragEnd: ({ active, over }) =>
      over
        ? t('dnd.dropped', { name: nameOf(active.id), position: positionOf(over.id), total })
        : t('dnd.cancelled', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('dnd.cancelled', { name: nameOf(active.id) }),
  };
  const instructions: ScreenReaderInstructions = { draggable: t('dnd.instructions') };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const intent = moveIntent(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    if (!intent) return;
    const next = ids.filter((id) => id !== intent.id);
    next.splice(ids.indexOf(String(over.id)), 0, intent.id);
    setPending({ base: views, ids: next });
    Promise.resolve(
      onMove(intent.id, { afterId: intent.afterId, beforeId: intent.beforeId }),
    ).catch(() => {
      setPending(null);
      toast({ message: t('error.saveFailed'), tone: 'danger' });
    });
  };

  const label = t('savedViews.label', { name: orgName });

  if (rail) {
    if (ordered.length === 0) return null;
    return (
      <ul aria-label={label} className="flex flex-col items-center gap-0.5">
        {ordered.map((view) => (
          <li key={view.id}>
            <SidebarItem
              rail
              icon={isProjectView(view.query) ? Hash : Search}
              label={view.name}
              railHint={orgName}
              href={paths.savedView(slug, view.id)}
              isActive={activeViewId === view.id}
              count={view.openCount}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    // Set apart from the built-in views by a little air, not a heading: the icons say the rest.
    <div className="mt-2 flex flex-col gap-0.5" data-testid="sidebar-views">
      {ordered.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[verticalOnly]}
          onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: instructions }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul aria-label={label} className="flex flex-col gap-0.5">
              {ordered.map((view, index) => (
                <SavedViewItem
                  key={view.id}
                  view={view}
                  href={paths.savedView(slug, view.id)}
                  isActive={activeViewId === view.id}
                  forceDragging={forceDragging && index === 0}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <SidebarItem
        icon={Plus}
        label={t('savedViews.new')}
        href={paths.newSavedView(slug)}
        isActive={activeViewId === 'new'}
        quiet
        data-testid="sidebar-new-view"
      />
    </div>
  );
});

function SavedViewItem({
  view,
  href,
  isActive,
  forceDragging,
}: {
  view: SavedView;
  href: string;
  isActive: boolean;
  forceDragging: boolean;
}) {
  const { t } = useTranslation('shell');
  const sortable = useSortable({ id: view.id });
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition } =
    sortable;
  const isDragging = sortable.isDragging || forceDragging;
  // A pointer drag ends with a click on the link: swallow that one (the org header does too).
  const dragged = useRef(false);
  if (sortable.isDragging) dragged.current = true;
  const project = isProjectView(view.query);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-view-id={view.id}
      data-project={project ? '' : undefined}
      onPointerDownCapture={(event) => {
        dragged.current = false;
        listeners?.onPointerDown?.(event);
      }}
      onClickCapture={(event) => {
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'group/view relative rounded-sm',
        isDragging && 'z-(--z-drag) bg-bg-elevated shadow-lg',
      )}
    >
      <SidebarItem
        icon={project ? Hash : Search}
        label={view.name}
        href={href}
        isActive={isActive}
        count={view.openCount}
      />
      {/*
       * Over the count's end of the row, on the row's hover background: the count stays where
       * the other rows have theirs, and the grip appears where it is reached (hover, focus).
       */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        onKeyDown={listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined}
        aria-label={t('savedViews.reorder', { name: view.name })}
        // While lifted, the keys belong to the drag: the list's arrows and Space (the keymap's
        // navigate scope) must not move its cursor or act on a task meanwhile.
        data-overlay={sortable.isDragging ? '' : undefined}
        className={cn(
          'absolute inset-y-0 end-0 my-auto flex size-control-sm cursor-grab items-center justify-center rounded-sm bg-bg-muted text-icon-subtle',
          'opacity-0 transition-opacity duration-(--dur-fade) group-hover/view:opacity-100 focus-ring:opacity-100',
          'outline-offset-0 focus-ring:outline-2 focus-ring:outline-border-focus',
          'pointer-coarse:hidden',
          isDragging && 'cursor-grabbing opacity-100',
        )}
      >
        <GripVertical className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
      </button>
    </li>
  );
}
