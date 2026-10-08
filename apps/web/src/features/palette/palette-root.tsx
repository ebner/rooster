import type { ListState } from '@rooster/core/reducers';
import type { SearchHit, Tag, Task } from '@rooster/core/schemas';
import { type LocalSearchContext, parseSearchQuery } from '@rooster/core/search';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { findOrg, useMe } from '../../data';
import { cachedListStates, useSearch } from '../../data/search';
import type { Me, Org } from '../../data/types';
import { useSyncStore } from '../../state/sync-store';
import { useIsMobile, useKeyboardInset } from '../../ui/use-media';
import { hasShortcutHandler, runShortcut, useKeymapHandlers } from '../../use-keymap';
import { useViewerDateContext } from '../dates';
import { orgUrlSlug, paths } from '../shell/paths';
import { buildActions } from './actions';
import { currentPaletteCommands, subscribePaletteCommands } from './commands';
import {
  type ActionItem,
  buildSections,
  type ChipContext,
  findCachedTask,
  highlightTerms,
  nextActiveKey,
  type PaletteItem,
  type PaletteSection,
  plainText,
  type SectionId,
  searchCachedTasks,
  splitSnippet,
  subtreeOf,
  type TaskItem,
  type TaskSummary,
  taskChip,
} from './model';
import { PalettePanel } from './palette-panel';
import { readRecentTasks, updateRecentTitles } from './recent-tasks';
import { closePalette, paletteReturnFocus, usePaletteStore } from './store';

/** 02 §12: the search request waits for a 150 ms pause in typing. */
export const searchDebounceMs = 150;

/** The "Make subtask of…" step (ADR 0008): pick a parent in the selection's org. */
interface SubtaskStep {
  orgId: string;
  ids: readonly string[];
  /** The selection and its descendants (never offered as the parent). */
  exclude: ReadonlySet<string>;
  run: (parentId: string) => void;
}

function useCurrentOrg(me: Me | undefined): Org | null {
  const { orgSlug } = useParams({ strict: false });
  return orgSlug && me ? findOrg(me.orgs, orgSlug) : null;
}

function dataPath(org: Org | null, hash = ''): string {
  const search = org ? `?org=${encodeURIComponent(orgUrlSlug(org))}` : '';
  return `${paths.settings('data')}${search}${hash}`;
}

/**
 * The command palette (02 §12, FR-VIEW-3/4), lazy-loaded on first use and kept mounted after
 * that. It also handles the registry's palette-only commands (`keys: []`).
 */
export function PaletteRoot() {
  const open = usePaletteStore((s) => s.open);
  const session = usePaletteStore((s) => s.session);
  const me = useMe().data;
  const currentOrg = useCurrentOrg(me);
  const navigate = useNavigate();
  const go = (href: string) => void navigate({ href });

  useKeymapHandlers({
    openTrash: () => go(dataPath(currentOrg, '#trash')),
    exportData: () => go(dataPath(currentOrg)),
    openOrgSettings: () => {
      if (!currentOrg) return false;
      go(paths.orgSettings(orgUrlSlug(currentOrg)));
    },
    openAdmin: () => {
      if (!me?.user.isAdmin) return false;
      go(paths.admin);
    },
  });

  if (!open || !me) return null;
  return <PaletteSession key={session} me={me} currentOrg={currentOrg} />;
}

const emptyTags: Readonly<Record<string, Tag>> = {};

function cachedTags(lists: readonly ListState[], tagLists: readonly (readonly Tag[])[]) {
  if (tagLists.length === 0 && lists.length === 0) return emptyTags;
  const byId: Record<string, Tag> = {};
  for (const tags of tagLists) for (const tag of tags) byId[tag.id] = tag;
  return byId;
}

function PaletteSession({ me, currentOrg }: { me: Me; currentOrg: Org | null }) {
  const { t } = useTranslation('palette');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const initialQuery = usePaletteStore((s) => s.initialQuery);
  const mode = usePaletteStore((s) => s.mode);
  const online = useSyncStore((s) => s.online);
  const commands = useSyncExternalStore(
    subscribePaletteCommands,
    currentPaletteCommands,
    currentPaletteCommands,
  );
  const phone = useIsMobile();
  const keyboard = useKeyboardInset();
  const dateCtx = useViewerDateContext();

  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [allOrgs, setAllOrgs] = useState(currentOrg === null);
  const [step, setStep] = useState<SubtaskStep | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    if (query === debounced) return;
    const timer = setTimeout(() => setDebounced(query), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [query, debounced]);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const searchParsed = useMemo(() => parseSearchQuery(debounced), [debounced]);
  const scopeOrgId = step ? step.orgId : allOrgs ? null : (currentOrg?.id ?? null);
  const wantsTasks = !searchParsed.actionsOnly && debounced.trim() !== '';
  const search = useSearch({
    q: debounced.trim(),
    orgId: scopeOrgId,
    enabled: online && wantsTasks,
  });
  const fromCache = !online || search.error !== null;

  const orgById = useMemo(() => new Map(me.orgs.map((o) => [o.id, o])), [me.orgs]);
  const orgIds = useMemo(() => new Set(orgById.keys()), [orgById]);

  // The cache is read once per render: cheap (a few maps), and always current. Only orgs in
  // the current `/me` count: a revoked membership's cached data never shows.
  const lists = cachedListStates(queryClient, orgIds);
  const tagsById = cachedTags(
    lists,
    queryClient
      .getQueriesData<readonly Tag[]>({ queryKey: ['tags'] })
      .flatMap(([key, tags]) =>
        tags && typeof key[1] === 'string' && orgIds.has(key[1]) ? [tags] : [],
      ),
  );
  const listOf = (orgId: string) => lists.find((l) => l.orgId === orgId);
  const exclude = step?.exclude;

  const chipContext: ChipContext = {
    currentOrgId: currentOrg?.id ?? null,
    orgNames: new Map(me.orgs.map((o) => [o.id, o.name])),
    lists,
    inboxLabel: t('chip.inbox'),
  };
  const taskItem = (
    section: SectionId,
    task: TaskSummary & Partial<Task>,
    orgId: string,
    snippet: string | null,
    terms: readonly string[],
  ): TaskItem => {
    // FTS5 marks whole words; titles mark the matched prefix, as offline. The snippet only
    // shows when the match is elsewhere (description, comments).
    const title = highlightTerms(task.title, terms);
    const marked = snippet === null ? null : splitSnippet(snippet);
    const inTitle =
      title.some((s) => s.mark) || (marked !== null && plainText(marked) === task.title);
    return {
      kind: 'task',
      key: `${section}:${task.id}`,
      task,
      orgId,
      title,
      snippet: inTitle || marked === null || !marked.some((s) => s.mark) ? null : marked,
      chip: taskChip(orgId, task, chipContext),
    };
  };

  // Recents (02 §12): current titles from the cache, the stored title otherwise.
  const recentEntries = useMemo(() => readRecentTasks(me.user.id), [me.user.id]);
  const recents: TaskItem[] = recentEntries.flatMap((entry) => {
    if (!orgById.has(entry.orgId)) return [];
    if (step && (entry.orgId !== step.orgId || exclude?.has(entry.id))) return [];
    const list = listOf(entry.orgId);
    if (list?.deletedTasks[entry.id]) return [];
    const cached =
      findCachedTask(lists, entry.id) ?? queryClient.getQueryData<Task>(['task', entry.id]);
    if (!cached && !entry.title) return [];
    const task: TaskSummary = cached ?? {
      id: entry.id,
      title: entry.title,
      dueDate: null,
      dueTime: null,
      dueTz: null,
      startDate: null,
      completedAt: null,
    };
    return [taskItem('recent', task, entry.orgId, null, [])];
  });
  useEffect(() => {
    const titles = new Map(recents.map((r) => [r.task.id, r.task.title]));
    updateRecentTitles(me.user.id, titles);
  });

  const localCtx: LocalSearchContext = {
    today: dateCtx.today,
    nowMs: dateCtx.nowMs,
    viewerTz: dateCtx.timezone,
    viewerId: me.user.id,
    tagsById,
  };

  let tasks: TaskItem[] = [];
  if (step && query.trim() === '') {
    // The picker starts with the org's open tasks, most recently changed first.
    const open = { ...parseSearchQuery(''), status: 'open' as const };
    tasks = searchCachedTasks(lists, open, localCtx, { orgId: step.orgId, exclude, limit: 20 }).map(
      (task) => taskItem('tasks', task, task.orgId, null, []),
    );
  } else if (!parsed.actionsOnly && query.trim() !== '') {
    if (fromCache) {
      tasks = searchCachedTasks(lists, parsed, localCtx, { orgId: scopeOrgId, exclude }).map(
        (task) => taskItem('tasks', task, task.orgId, null, parsed.terms),
      );
    } else {
      tasks = (search.data ?? [])
        .filter((hit: SearchHit) => orgIds.has(hit.orgId) && !exclude?.has(hit.task.id))
        .map((hit) => taskItem('tasks', hit.task, hit.orgId, hit.snippet, searchParsed.terms));
    }
  }

  const actions: ActionItem[] = step
    ? []
    : buildActions({
        orgs: me.orgs,
        currentOrg,
        isAdmin: me.user.isAdmin,
        hasSelection: (commands?.selectedTaskIds.length ?? 0) > 0,
        canMakeSubtask: Boolean(commands?.makeSubtaskOf),
        phone,
        isAvailable: hasShortcutHandler,
        label: (id) => t(`action.${id}`),
        goToOrgLabel: (name) => t('action.goToOrg', { name }),
      });

  const sections: PaletteSection[] = step
    ? [
        ...(query.trim() === '' && recents.length > 0
          ? [{ id: 'recent' as const, items: recents }]
          : []),
        ...(tasks.length > 0 ? [{ id: 'tasks' as const, items: tasks }] : []),
      ]
    : buildSections({
        query,
        parsed,
        recents,
        tasks,
        actions,
        searchMode: mode === 'search',
      });

  const active = nextActiveKey(sections, activeKey);
  const waiting =
    !fromCache &&
    !parsed.actionsOnly &&
    query.trim() !== '' &&
    (query !== debounced || search.isPending);
  const emptyText = waiting
    ? null
    : query.trim() === ''
      ? step
        ? t('empty.picker')
        : t('empty.start')
      : parsed.actionsOnly
        ? t('empty.actions')
        : t('empty.tasks', { query: query.trim() });

  const scopeOrg = !allOrgs && currentOrg && me.orgs.length > 1 ? currentOrg.name : null;
  const placeholder =
    mode === 'search'
      ? scopeOrg
        ? t('placeholder.searchIn', { org: scopeOrg })
        : t('placeholder.search')
      : scopeOrg
        ? t('placeholder.commandIn', { org: scopeOrg })
        : t('placeholder.command');

  const select = (item: PaletteItem) => {
    if (item.kind === 'task') {
      if (step) {
        closePalette(true);
        step.run(item.task.id);
        return;
      }
      const org = orgById.get(item.orgId);
      if (!org) return;
      closePalette(true);
      void navigate({ href: paths.task(orgUrlSlug(org), item.task.id) });
      return;
    }
    if (item.commandId === 'makeSubtaskOf') {
      const current = currentPaletteCommands();
      if (!current?.makeSubtaskOf || current.selectedTaskIds.length === 0) return;
      setStep({
        orgId: current.orgId,
        ids: current.selectedTaskIds,
        exclude: subtreeOf(listOf(current.orgId), current.selectedTaskIds),
        run: current.makeSubtaskOf,
      });
      setQuery('');
      setDebounced('');
      setActiveKey(null);
      return;
    }
    const target = paletteReturnFocus();
    closePalette(true);
    const handled =
      item.commandId === 'goToOrg' && !item.args
        ? false
        : runShortcut(item.commandId, { target, ...item.args });
    if (!handled) fallback(item);
  };

  /** Navigation actions still work where no screen handles their key. */
  const fallback = (item: ActionItem) => {
    if (item.href) {
      void navigate({ href: item.href });
      return;
    }
    const org = currentOrg ?? me.orgs[0];
    const views = {
      goMyTasks: 'my',
      goToday: 'today',
      goWeek: 'week',
      goOverdue: 'overdue',
      goNoDate: 'nodate',
    } as const;
    if (item.commandId in views && org) {
      const view = views[item.commandId as keyof typeof views];
      void navigate({ href: paths.orgView(orgUrlSlug(org), view) });
    } else if (item.commandId === 'goSettings') {
      void navigate({ href: '/settings' });
    }
  };

  return (
    <PalettePanel
      variant={phone ? 'sheet' : 'floating'}
      query={query}
      onQueryChange={setQuery}
      placeholder={placeholder}
      sections={sections}
      activeKey={active}
      onActiveKeyChange={setActiveKey}
      onSelect={select}
      onClose={() => closePalette(true)}
      step={
        step
          ? {
              title: t('picker.title', { count: step.ids.length }),
              onBack: () => {
                setStep(null);
                setQuery('');
                setDebounced('');
              },
            }
          : undefined
      }
      offline={fromCache && (query.trim() !== '' || step !== null) && !parsed.actionsOnly}
      loading={search.isFetching}
      emptyText={emptyText}
      scope={currentOrg && me.orgs.length > 1 ? { allOrgs, onChange: setAllOrgs } : undefined}
      dateCtx={dateCtx}
      keyboardInset={phone ? keyboard : 0}
    />
  );
}
