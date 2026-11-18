import type { SavedView, SavedViewQuery } from '@rooster/core/schemas';
import { useLocation } from '@tanstack/react-router';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { useTags } from '../../data/tags';
import type { Org } from '../../data/types';
import { useViewTasks, viewCounts } from '../../data/view-tasks';
import { useViews } from '../../data/views';
import { useListStore } from '../../state/list-store';
import { Button, buttonVariants } from '../../ui/button';
import { useIsMobile } from '../../ui/use-media';
import { useKeymapHandlers } from '../../use-keymap';
import { useViewerDateContext } from '../dates';
import type { PaneControls } from '../pane/pane-controls';
import { useSortedMembers } from '../people/members';
import { ViewBody, ViewHeader } from '../shell/app-shell';
import type { ViewTab } from '../shell/mobile-header';
import { orgUrlSlug, paths } from '../shell/paths';
import { forgetListPath } from '../shell/start-page';
import { requestViewNameFocus } from './name-focus';
import { QuerySheet } from './query-sheet';
import {
  DeleteViewConfirm,
  SavedViewHeader,
  showsCounts,
  ViewCounts,
  ViewMenuItems,
} from './saved-view-header';
import { needsCompleted, SavedViewList } from './saved-view-list';
import { useViewEditor } from './use-view-editor';

/** The ID in `/o/<slug>/v/new`: "+ New view", not created yet (B7). */
export const newViewId = 'new';

/** "7 open · 12 done" (B3), subscribed to the rows on its own (the header stays still). */
function LiveCounts({
  orgId,
  viewId,
  userId,
  query,
}: {
  orgId: string;
  viewId: string;
  userId: string;
  query: SavedViewQuery;
}) {
  const dateCtx = useViewerDateContext();
  const showCompleted = useListStore((s) => s.showCompleted);
  const completed = needsCompleted(query, showCompleted);
  const data = useViewTasks(orgId, viewId, completed).data;
  if (!data) return null;
  const counts = viewCounts(data, query, {
    viewerId: userId,
    due: { today: dateCtx.today, nowMs: dateCtx.nowMs, viewerTz: dateCtx.timezone },
  });
  return <ViewCounts counts={counts} />;
}

/** A view that is gone, archived or someone else's private one: a quiet note and a way back. */
export function ViewNotFound({ org, userId }: { org: Org; userId: string }) {
  const { t } = useTranslation('views');
  const { pathname } = useLocation();
  // `/` stops reopening a view that is gone (the start page's "last view").
  useEffect(() => forgetListPath(userId, pathname), [userId, pathname]);
  return (
    <>
      <ViewHeader title={t('saved.notFound.title')} context={org.name} />
      <ViewBody>
        <div data-testid="view-not-found" className="flex flex-col items-start gap-4 pt-8">
          <p className="text-md text-text-secondary">{t('saved.notFound.body')}</p>
          <Link
            href={paths.orgView(orgUrlSlug(org), 'my')}
            className={buttonVariants({ variant: 'secondary' })}
          >
            {t('saved.notFound.back')}
          </Link>
        </div>
      </ViewBody>
    </>
  );
}

export interface SavedViewContentProps {
  org: Org;
  userId: string;
  /** The view's ID, or `new` for "+ New view". */
  viewId: string;
  pane?: PaneControls | undefined;
  /** The phone's view switcher. */
  tabs: readonly ViewTab[];
}

/**
 * A view of the org (ADR 0073 B, 02 §10.2): its header (name, query chips, sharing, ⋯) over
 * its rows by person. `/o/<slug>/v/new` is a new view, created once it has a name.
 */
export function SavedViewContent(props: SavedViewContentProps) {
  const { org, viewId } = props;
  const views = useViews(org.id);
  if (viewId === newViewId) return <LoadedView {...props} view={null} key="new" />;
  const view = views.data?.find((v) => v.id === viewId);
  if (view) return <LoadedView {...props} view={view} key={view.id} />;
  if (views.isPending) return null;
  // Only a loaded list that lacks the view means it's gone; a failed load (offline, rate
  // limited) is a load error, and must not forget the start page's "last view".
  if (!views.data) return <ViewLoadFailed org={org} />;
  return <ViewNotFound org={org} userId={props.userId} />;
}

/** The views list couldn't be loaded (and none is cached): say so, without guessing why. */
function ViewLoadFailed({ org }: { org: Org }) {
  const { t } = useTranslation('views');
  const { t: tList } = useTranslation('list');
  return (
    <>
      <ViewHeader title={t('saved.title')} context={org.name} />
      <ViewBody>
        <p role="alert" data-testid="view-load-failed" className="pt-8 text-sm text-text-secondary">
          {tList('state.loadFailed')}
        </p>
      </ViewBody>
    </>
  );
}

function LoadedView({
  org,
  userId,
  viewId,
  pane,
  tabs,
  view,
}: SavedViewContentProps & { view: SavedView | null }) {
  const { t } = useTranslation('views');
  const mobile = useIsMobile();
  const editor = useViewEditor(org, userId, view);
  const tags = useTags(org.id).data ?? [];
  const members = useSortedMembers(org.isPersonal ? undefined : org.id, userId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A new view on a phone opens with its sheet, the name first.
  const [sheetOpen, setSheetOpen] = useState(editor.isNew && mobile);
  const { draft } = editor;
  const title = draft.name || t('saved.suggest.fallback');
  const counts =
    view && showsCounts(draft.query) ? (
      <LiveCounts orgId={org.id} viewId={view.id} userId={userId} query={draft.query} />
    ) : null;

  // The header's actions from the palette (keyboard parity, hard rule 8).
  useKeymapHandlers({
    renameView: () => {
      if (mobile) setSheetOpen(true);
      else requestViewNameFocus();
    },
    ...(view
      ? {
          archiveView: () => editor.archive(),
          deleteView: () => setConfirmingDelete(true),
          ...(org.isPersonal || (draft.shared && !editor.canUnshare)
            ? {}
            : { toggleViewShared: () => editor.setShared(!draft.shared) }),
        }
      : {}),
  });

  const confirm = confirmingDelete && (
    <DeleteViewConfirm
      name={draft.name}
      onConfirm={() => {
        setConfirmingDelete(false);
        editor.remove();
      }}
      onCancel={() => setConfirmingDelete(false)}
    />
  );

  return (
    <>
      {mobile ? (
        <ViewHeader
          title={title}
          context={org.name}
          mobile={{
            switcher: true,
            views: tabs,
            actions: (
              <Button
                variant="ghost"
                size="sm"
                icon={SlidersHorizontal}
                data-testid="view-filters"
                aria-label={t('saved.chips.sheet')}
                onPress={() => setSheetOpen(true)}
              >
                <span className="sr-only">{t('saved.chips.button')}</span>
              </Button>
            ),
            menu: (
              <ViewMenuItems editor={editor} onDelete={() => setConfirmingDelete(true)} mobile />
            ),
          }}
        />
      ) : (
        <SavedViewHeader
          org={org}
          userId={userId}
          editor={editor}
          tags={tags}
          members={members}
          counts={counts}
          confirmingDelete={confirmingDelete}
          setConfirmingDelete={setConfirmingDelete}
        />
      )}
      {mobile && (
        <QuerySheet
          isOpen={sheetOpen}
          onOpenChange={setSheetOpen}
          org={org}
          userId={userId}
          editor={editor}
          tags={tags}
          members={members}
        />
      )}
      {/* Printed above the list only (styles/print.css). */}
      <p data-print-title className="hidden">
        {title} <span>{org.name}</span>
      </p>
      <ViewBody>
        {mobile && (counts || confirm) && (
          <div className="flex flex-col gap-2 pb-2">
            {counts && <div className="flex">{counts}</div>}
            {confirm}
          </div>
        )}
        {view ? (
          <SavedViewList
            orgId={org.id}
            userId={userId}
            viewId={viewId}
            query={draft.query}
            isPersonal={org.isPersonal}
            label={title}
            pane={pane}
          />
        ) : (
          <p data-testid="view-new-hint" className="pt-6 text-sm text-text-muted">
            {t('saved.newHint')}
          </p>
        )}
      </ViewBody>
    </>
  );
}
