import { uuidv7 } from '@rooster/core/ids';
import { DEFAULT_PREFS } from '@rooster/core/limits';
import { listOps } from '@rooster/core/reducers';
import type { SavedView, SavedViewPatch, SavedViewQuery } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../data/errors';
import { useListPipeline } from '../../data/list';
import { queryKeys } from '../../data/query-keys';
import { sessionScope } from '../../data/session-events';
import type { Org } from '../../data/types';
import { useArchiveView, useCreateView, useDeleteView, useUpdateView } from '../../data/views';
import { useSyncStore } from '../../state/sync-store';
import { toast } from '../../ui/toast';
import { useViewerDateContext } from '../dates';
import { announce } from '../list/announcer';
import { orgUrlSlug, paths } from '../shell/paths';
import { emptyViewQuery, viewNameMax } from './query';
import { addCreatedView, mayWriteViews } from './view-cache';

/** A field's edit waiting for its answer, and its place in the order of edits. */
type Edits = Partial<Record<keyof ViewDraft, { value: unknown; seq: number }>>;

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
  /** Whether "Private" is offered: a shared view only its creator may make private (B8). */
  canUnshare: boolean;
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
 * settings). The edit shows here at once (the rows re-filter by `draft.query`); the views
 * cache only ever takes the server's answers, checked against the session and the org. A new
 * view lives here until it is named, then it is created and the URL takes its ID.
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
  /**
   * A saved view's edits on their way to the server (B7: changes save at once). They show
   * here only: the views cache takes nothing but the server's answers, so a failure has
   * nothing to roll back there (it drops its edit and refetches). Per field, the latest edit.
   */
  const [edits, setEdits] = useState<Edits>({});
  const editSeq = useRef(0);
  /** Per field, the newest edit whose answer was written to the cache. */
  const answered = useRef<Partial<Record<keyof ViewDraft, number>>>({});
  const draft: ViewDraft = view
    ? {
        name: (edits.name?.value as string | undefined) ?? view.name,
        query: (edits.query?.value as SavedViewQuery | undefined) ?? view.query,
        shared: (edits.shared?.value as boolean | undefined) ?? view.shared,
      }
    : local;

  const offline = () => {
    if (online) return false;
    toast({ message: t('saved.offline'), tone: 'danger' });
    return true;
  };
  const failed = (error?: unknown) =>
    toast({
      message: t(errorCode(error) === 'view_limit' ? 'saved.limit' : 'saved.saveFailed'),
      tone: 'danger',
    });
  /** A view deleted or archived here: its rows' caches go too (no screen shows them). */
  const forget = (id: string) => queryClient.removeQueries({ queryKey: ['view-tasks', id] });

  const liveKey = queryKeys.views(org.id, false);
  const settle = (seq: number, fields: readonly (keyof ViewDraft)[]) =>
    setEdits((current) => {
      const next = { ...current };
      for (const field of fields) if (next[field]?.seq === seq) delete next[field];
      return next;
    });
  const patchView = (patch: SavedViewPatch) => {
    if (!view || offline()) return;
    const session = sessionScope();
    const seq = ++editSeq.current;
    const fields = (Object.keys(patch) as (keyof ViewDraft)[]).filter(
      (field) => patch[field] !== undefined,
    );
    setEdits((current) => {
      const next = { ...current };
      for (const field of fields) next[field] = { value: patch[field], seq };
      return next;
    });
    update.mutateAsync({ id: view.id, patch }).then(
      (saved) => {
        // A sign-out or a left org meanwhile: its caches are gone and must stay so.
        if (!mayWriteViews(queryClient, org.id, session)) return;
        // An older answer arriving after a newer one's doesn't overwrite it.
        if (!fields.some((field) => (answered.current[field] ?? 0) > seq)) {
          for (const field of fields) answered.current[field] = seq;
          queryClient.setQueryData<SavedView[]>(liveKey, (list) =>
            list?.map((v) => (v.id === saved.id ? { ...v, ...saved } : v)),
          );
        }
        settle(seq, fields);
        if (patch.query) void queryClient.invalidateQueries({ queryKey: ['view-tasks', view.id] });
      },
      (error: unknown) => {
        if (!mayWriteViews(queryClient, org.id, session)) return;
        failed(error);
        settle(seq, fields);
        void queryClient.invalidateQueries({ queryKey: liveKey });
      },
    );
  };

  const createNow = (next: ViewDraft) => {
    if (creating.current || offline()) return;
    creating.current = true;
    const session = sessionScope();
    create
      .mutateAsync({
        id: uuidv7(),
        name: next.name,
        query: next.query,
        ...(org.isPersonal ? {} : { shared: next.shared }),
      })
      .then(
        (created) => {
          if (!mayWriteViews(queryClient, org.id, session)) return;
          addCreatedView(queryClient, created);
          announce(t('saved.created', { name: created.name }));
          void navigate({ href: paths.savedView(slug, created.id), replace: true });
        },
        (error: unknown) => {
          creating.current = false;
          if (mayWriteViews(queryClient, org.id, session)) failed(error);
        },
      );
  };

  const setName = (raw: string) => {
    const name = cleanName(raw);
    if (name === '') return;
    if (view) {
      if (name !== draft.name) patchView({ name });
      return;
    }
    // A new view: also the same name again, after a create that failed (or was offline).
    const next = { ...local, name };
    setLocal(next);
    createNow(next);
  };
  // Making a shared view private makes it its creator's alone: only they may (B8).
  const canUnshare = !view || view.createdBy === userId;

  return {
    draft,
    isNew: view === null,
    setName,
    setQuery: (query) => {
      if (view) patchView({ query });
      else setLocal((d) => ({ ...d, query }));
    },
    canUnshare,
    setShared: (shared) => {
      if (org.isPersonal || shared === draft.shared || (!shared && !canUnshare)) return;
      if (view) patchView({ shared });
      else setLocal((d) => ({ ...d, shared }));
    },
    archive: () => {
      if (!view || offline()) return;
      archiveView.mutateAsync({ id: view.id, archived: true }).then(() => {
        void navigate({ href: paths.orgView(slug, 'my') });
        forget(view.id);
        toast({
          message: t('saved.archived', { name: view.name }),
          action: {
            label: t('saved.restore'),
            onAction: () => {
              archiveView.mutateAsync({ id: view.id, archived: false }).then(
                () => void navigate({ href: paths.savedView(slug, view.id) }),
                (error: unknown) => failed(error),
              );
            },
          },
        });
      }, failed);
    },
    remove: () => {
      if (!view || offline()) return;
      deleteView.mutateAsync(view.id).then(() => {
        void navigate({ href: paths.orgView(slug, 'my') });
        forget(view.id);
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
