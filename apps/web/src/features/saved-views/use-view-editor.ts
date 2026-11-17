import { uuidv7 } from '@rooster/core/ids';
import { DEFAULT_PREFS } from '@rooster/core/limits';
import { listOps } from '@rooster/core/reducers';
import type { SavedView, SavedViewPatch, SavedViewQuery } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useListPipeline } from '../../data/list';
import { queryKeys } from '../../data/query-keys';
import type { Org } from '../../data/types';
import { useArchiveView, useCreateView, useDeleteView, useUpdateView } from '../../data/views';
import { useSyncStore } from '../../state/sync-store';
import { toast } from '../../ui/toast';
import { useViewerDateContext } from '../dates';
import { announce } from '../list/announcer';
import { orgUrlSlug, paths } from '../shell/paths';
import { emptyViewQuery, viewNameMax } from './query';

/** What the header edits: a saved view's name, query and sharing, or a new view's. */
export interface ViewDraft {
  name: string;
  query: SavedViewQuery;
  shared: boolean;
}

export interface ViewEditor {
  /** The view as shown: the saved one with its pending changes, or the new one. */
  draft: ViewDraft;
  /** A new view (`/v/new`), not created until it has a name. */
  isNew: boolean;
  /** Renames (a new view: creates it). Empty names are refused (the input restores). */
  setName: (name: string) => void;
  setQuery: (next: SavedViewQuery) => void;
  setShared: (shared: boolean) => void;
  archive: () => void;
  remove: () => void;
  /** A tag made from the tag chip ("Create …"), queued like any other, then added. */
  createTag: (name: string) => void;
}

function cleanName(name: string): string {
  return [...name.replace(/\s+/g, ' ').trim()].slice(0, viewNameMax).join('');
}

/**
 * The header's changes (ADR 0073 B7): a saved view is changed at once (online only, like org
 * settings; the views list is updated before the request so the rows re-filter at once, and
 * put back when it fails); a new view lives here until it is named, then it is created and the
 * URL takes its ID.
 */
export function useViewEditor(
  org: Org,
  userId: string,
  view: SavedView | null,
  initial?: ViewDraft,
): ViewEditor {
  const { t } = useTranslation('views');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pipeline = useListPipeline();
  const dateCtx = useViewerDateContext();
  const online = useSyncStore((s) => s.online);
  const update = useUpdateView(org.id);
  const create = useCreateView(org.id);
  const archiveView = useArchiveView(org.id);
  const deleteView = useDeleteView(org.id);
  const slug = orgUrlSlug(org);
  const [local, setLocal] = useState<ViewDraft>(
    () => initial ?? { name: '', query: emptyViewQuery, shared: false },
  );
  const creating = useRef(false);
  const draft: ViewDraft = view
    ? { name: view.name, query: view.query, shared: view.shared }
    : local;

  const offline = () => {
    if (online) return false;
    toast({ message: t('saved.offline'), tone: 'danger' });
    return true;
  };
  const failed = () => toast({ message: t('saved.saveFailed'), tone: 'danger' });

  const liveKey = queryKeys.views(org.id, false);
  const patchView = (patch: SavedViewPatch) => {
    if (!view || offline()) return;
    const before = queryClient.getQueryData<SavedView[]>(liveKey);
    queryClient.setQueryData<SavedView[]>(liveKey, (list) =>
      list?.map((v) =>
        v.id === view.id
          ? {
              ...v,
              name: patch.name ?? v.name,
              query: patch.query ?? v.query,
              shared: patch.shared ?? v.shared,
            }
          : v,
      ),
    );
    update.mutateAsync({ id: view.id, patch }).then(
      () => {
        if (patch.query) void queryClient.invalidateQueries({ queryKey: ['view-tasks', view.id] });
      },
      () => {
        if (before) queryClient.setQueryData(liveKey, before);
        failed();
      },
    );
  };

  const createNow = (next: ViewDraft) => {
    if (creating.current || offline()) return;
    creating.current = true;
    create
      .mutateAsync({
        id: uuidv7(),
        name: next.name,
        query: next.query,
        ...(org.isPersonal ? {} : { shared: next.shared }),
      })
      .then(
        (created) => {
          // In the list before the URL names it, so the screen never shows "not found".
          queryClient.setQueryData<SavedView[]>(liveKey, (list) =>
            list?.some((v) => v.id === created.id) ? list : [...(list ?? []), created],
          );
          announce(t('saved.created', { name: created.name }));
          void navigate({ href: paths.savedView(slug, created.id), replace: true });
        },
        () => {
          creating.current = false;
          failed();
        },
      );
  };

  const setName = (raw: string) => {
    const name = cleanName(raw);
    if (name === '' || name === draft.name) return;
    if (view) patchView({ name });
    else {
      const next = { ...local, name };
      setLocal(next);
      createNow(next);
    }
  };

  return {
    draft,
    isNew: view === null,
    setName,
    setQuery: (query) => {
      if (view) patchView({ query });
      else setLocal((d) => ({ ...d, query }));
    },
    setShared: (shared) => {
      if (org.isPersonal || shared === draft.shared) return;
      if (view) patchView({ shared });
      else setLocal((d) => ({ ...d, shared }));
    },
    archive: () => {
      if (!view || offline()) return;
      archiveView.mutateAsync({ id: view.id, archived: true }).then(() => {
        void navigate({ href: paths.orgView(slug, 'my') });
        toast({
          message: t('saved.archived', { name: view.name }),
          action: {
            label: t('saved.restore'),
            onAction: () => {
              archiveView
                .mutateAsync({ id: view.id, archived: false })
                .then(() => void navigate({ href: paths.savedView(slug, view.id) }), failed);
            },
          },
        });
      }, failed);
    },
    remove: () => {
      if (!view || offline()) return;
      deleteView.mutateAsync(view.id).then(() => {
        void navigate({ href: paths.orgView(slug, 'my') });
        toast({ message: t('saved.deleted', { name: view.name }) });
      }, failed);
    },
    createTag: (raw) => {
      const name = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name === '' || offline()) return;
      const id = uuidv7();
      pipeline.enqueue(org.id, [listOps.createTag({ id, name })], {
        userId,
        timezone: dateCtx.timezone,
        allDayReminderTime: DEFAULT_PREFS.allDayReminderTime,
      });
      // The view refers to the tag by ID: it is saved once the server has the tag.
      const query = { ...draft.query, tags: [...draft.query.tags, id] };
      void pipeline.idle().then(() => {
        if (view) patchView({ query });
        else setLocal((d) => ({ ...d, query: { ...d.query, tags: [...d.query.tags, id] } }));
      });
    },
  };
}
