import { uuidv7 } from '@rooster/core/ids';
import {
  inboxOf,
  inverseOfSequence,
  type ListOpSpec,
  type ListState,
  listOps,
} from '@rooster/core/reducers';
import { type MergedLists, mergeOrgLists } from '../../data/all-views';
import type { Org } from '../../data/types';
import { joinUndoParts, type UndoEntry, useUndoStore } from '../../state/undo-store';
import { toast } from '../../ui/toast';
import {
  type CommitResult,
  type ControllerDeps,
  ListController,
  type TitleScope,
} from '../list/controller';
import { blankSpan, type Span } from '../list/title-tokens';
import { resolveOrgToken } from './org-token';

/** One org of All organisations, with the list controller of its own tasks. */
export interface AllOrgScope {
  org: Org;
  controller: ListController;
}

export interface AllControllerDeps extends Omit<ControllerDeps, 'orgId'> {
  /** The viewer's orgs in sidebar order, each with its own controller, read live. */
  scopes: () => readonly AllOrgScope[];
  /** Where a new task goes without a `^org` token (ADR 0073 A4), read live. */
  defaultOrgId: () => string | undefined;
}

/**
 * All organisations (ADR 0073 A3): one list over every org's tasks. It reads the orgs' lists
 * as one state (navigation, selection, the rows' commands) and queues every op under the org
 * of the task it touches, so a bulk action over several orgs is one undo step whose parts go
 * to their own orgs. Commands that belong to one org (titles and their `#tag`/`@name`/`>Group`
 * tokens, tags, assignees, groups, new tasks) go to that org's own controller.
 */
export class AllListController extends ListController {
  readonly all: AllControllerDeps;

  constructor(deps: AllControllerDeps) {
    // No org of its own: every op names the org of its task (`run`).
    super({ ...deps, orgId: '' });
    this.all = deps;
  }

  private cache: {
    sources: readonly (ListState | undefined)[];
    merged: MergedLists | null;
  } | null = null;

  private lists(): MergedLists | null {
    const ids = this.orgIds();
    const sources = ids.map((orgId) => this.deps.pipeline.view(orgId));
    const cached = this.cache;
    if (
      cached &&
      cached.sources.length === sources.length &&
      cached.sources.every((source, i) => source === sources[i])
    ) {
      return cached.merged;
    }
    const merged = sources.some((s) => s !== undefined) ? mergeOrgLists(ids, sources) : null;
    this.cache = { sources, merged };
    return merged;
  }

  /** Every org's list as one state (ids are unique across orgs). */
  override state(): ListState | undefined {
    return this.lists()?.state;
  }

  override orgIds(): readonly string[] {
    return this.all.scopes().map((s) => s.org.id);
  }

  override orgOfTask(id: string): string | undefined {
    return this.lists()?.orgOfTask.get(id);
  }

  orgOfGroup(id: string): string | undefined {
    return this.lists()?.orgOfGroup.get(id);
  }

  /** The org's own controller. */
  controllerOf(orgId: string | undefined): ListController | undefined {
    return orgId ? this.all.scopes().find((s) => s.org.id === orgId)?.controller : undefined;
  }

  private orgById(orgId: string | undefined): Org | undefined {
    return orgId ? this.all.scopes().find((s) => s.org.id === orgId)?.org : undefined;
  }

  private defaultOrg(): Org | undefined {
    return this.orgById(this.all.defaultOrgId()) ?? this.all.scopes()[0]?.org;
  }

  override scoped(ids: readonly string[]): ListController | null {
    const orgs = new Set(ids.map((id) => this.orgOfTask(id)));
    if (orgs.size !== 1) return null;
    return this.controllerOf([...orgs][0]) ?? null;
  }

  /** Says that the tasks span orgs (tags, groups and people belong to one org). */
  private oneOrgOnly(): false {
    toast({ message: this.deps.t('all.oneOrg') });
    return false;
  }

  override refuseAcrossOrgs(ids: readonly string[]): boolean {
    if (ids.length === 0 || this.scoped(ids)) return false;
    this.oneOrgOnly();
    return true;
  }

  // -------------------------------------------------------------------------------------
  // Queueing: every op under its task's org, one undo entry for the whole operation
  // -------------------------------------------------------------------------------------

  /** The org an op belongs to: its task's (or, for a create, its group's or parent's). */
  private orgOfSpec(spec: ListOpSpec): string | undefined {
    if (spec.kind === 'task.create') {
      const { parentId, groupId } = spec.payload;
      return parentId ? this.orgOfTask(parentId) : groupId ? this.orgOfGroup(groupId) : undefined;
    }
    if ('taskId' in spec && typeof spec.taskId === 'string') return this.orgOfTask(spec.taskId);
    return this.orgOfTask(spec.entityId) ?? this.orgOfGroup(spec.entityId);
  }

  /** `specs` split by org, in order; a bulk op is split into one per org. */
  partition(specs: readonly ListOpSpec[]): Map<string, ListOpSpec[]> {
    const parts = new Map<string, ListOpSpec[]>();
    const add = (orgId: string | undefined, spec: ListOpSpec) => {
      if (!orgId) return;
      const list = parts.get(orgId) ?? [];
      list.push(spec);
      parts.set(orgId, list);
    };
    for (const spec of specs) {
      if (spec.kind === 'task.bulk') {
        const byOrg = new Map<string, string[]>();
        for (const id of spec.payload.ids) {
          const orgId = this.orgOfTask(id);
          if (!orgId) continue;
          byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), id]);
        }
        for (const [orgId, ids] of byOrg) {
          add(orgId, listOps.bulk(orgId, { ...spec.payload, ids } as typeof spec.payload));
        }
      } else {
        add(this.orgOfSpec(spec), spec);
      }
    }
    return parts;
  }

  override run(
    label: string,
    specs: ListOpSpec[],
    options: { toast?: boolean } = {},
  ): UndoEntry | null {
    const parts: UndoEntry[] = [];
    for (const [orgId, part] of this.partition(specs)) {
      const before = this.deps.pipeline.view(orgId);
      if (!before) continue;
      const inverseOps = inverseOfSequence(part, before, {
        ...this.reducerContext(),
        now: Date.now(),
      });
      this.deps.pipeline.enqueue(orgId, part, this.reducerContext());
      if (inverseOps.length > 0) parts.push({ orgId, label, inverseOps, redoOps: part });
    }
    const entry = joinUndoParts(parts);
    if (!entry) return null;
    useUndoStore.getState().push(entry);
    if (options.toast) {
      toast({
        message: label,
        action: { label: this.deps.t('undo.action'), onAction: () => this.undoEntry(entry) },
      });
    }
    return entry;
  }

  // -------------------------------------------------------------------------------------
  // New tasks (ADR 0073 A4): the default org, or the one a `^org` token names
  // -------------------------------------------------------------------------------------

  /** The `^org` token in a new task's title, if it names one of the viewer's orgs. */
  private orgToken(text: string, ignored: readonly Span[]): (Span & { org: Org }) | null {
    const orgs = this.all.scopes().map((s) => s.org);
    const token = resolveOrgToken(text, orgs);
    if (!token?.orgId || ignored.some((s) => s.start < token.end && token.start < s.end)) {
      return null;
    }
    const org = this.orgById(token.orgId);
    // A title made of the token alone keeps it as text (a task called "^idea" stays that).
    if (!org || blankSpan(text, token).trim() === '') return null;
    return { start: token.start, end: token.end, org };
  }

  private draft(rowId: string) {
    return this.ui().drafts.find((d) => d.id === rowId);
  }

  /** The org a new row's task goes to, and the title without its `^org` token. */
  private draftTarget(
    rowId: string,
    raw: string,
    ignored: readonly Span[],
  ): { org: Org | undefined; text: string; token: Span | null } {
    const draft = this.draft(rowId);
    if (draft?.parentId) {
      return { org: this.orgById(this.orgOfTask(draft.parentId)), text: raw, token: null };
    }
    const token = this.orgToken(raw, ignored);
    return token
      ? {
          org: token.org,
          text: blankSpan(raw, token),
          token: { start: token.start, end: token.end },
        }
      : { org: this.defaultOrg(), text: raw, token: null };
  }

  override titleScope(rowId: string, text: string, ignored: readonly Span[]): TitleScope {
    const draft = this.draft(rowId);
    if (!draft) {
      const own = this.controllerOf(this.orgOfTask(rowId));
      return { controller: own ?? this, orgToken: null, org: null };
    }
    const target = this.draftTarget(rowId, text, ignored);
    return {
      controller: this.controllerOf(target.org?.id) ?? this,
      orgToken: target.token,
      org: draft.parentId ? null : (target.org ?? null),
    };
  }

  override orgChoices(rowId: string): readonly Org[] {
    const draft = this.draft(rowId);
    return draft && !draft.parentId ? this.all.scopes().map((s) => s.org) : [];
  }

  /** New rows start in the default org (a subtask's in its parent's); the org can change. */
  override newSectionDraft(sectionId: string, afterId: string | null, parentId?: string) {
    const orgId = parentId ? this.orgOfTask(parentId) : this.defaultOrg()?.id;
    return this.controllerOf(orgId)?.newSectionDraft(sectionId, afterId, parentId) ?? null;
  }

  /**
   * Hands a new row to the org it goes to: the task lands in that org's Inbox unless `>Group`
   * (or the phone's group picker) names one of its groups.
   */
  private prepareDraft(
    rowId: string,
    raw: string,
    ignored: readonly Span[],
  ): { controller: ListController; text: string } | null {
    const target = this.draftTarget(rowId, raw, ignored);
    const controller = this.controllerOf(target.org?.id);
    const draft = this.draft(rowId);
    if (!controller || !draft) return null;
    const state = controller.state();
    if (!draft.parentId && state && !state.groups[draft.groupId]) {
      this.ui().updateDraft(rowId, { groupId: inboxOf(state)?.id ?? '' });
    }
    return { controller, text: target.text };
  }

  override commitTitle(rowId: string, raw: string, ignored: readonly Span[] = []): CommitResult {
    if (this.draft(rowId)) {
      const target = this.prepareDraft(rowId, raw, ignored);
      return target ? target.controller.commitTitle(rowId, target.text, ignored) : {};
    }
    return this.controllerOf(this.orgOfTask(rowId))?.commitTitle(rowId, raw, ignored) ?? {};
  }

  override draftCreates(rowId: string, raw: string, ignored: readonly Span[] = []): boolean {
    const target = this.draftTarget(rowId, raw, ignored);
    const controller = this.controllerOf(target.org?.id);
    return controller ? controller.draftCreates(rowId, target.text, ignored) : false;
  }

  /**
   * Pasted lines (02 §3.4): each goes to the org its own `^org` token names (the token is
   * removed), else the default org; one create per org, in the lines' order. Lines staying in
   * the org of the row's group (the phone's group picker) go there, the others to their org's
   * Inbox (or `>Group`). When an org's list isn't available (offline, never loaded), nothing
   * is created and the paste stays as it is, so no line is lost.
   */
  override createMany(rowId: string, lines: readonly string[]): boolean {
    const draft = this.draft(rowId);
    if (!draft) {
      return this.controllerOf(this.orgOfTask(rowId))?.createMany(rowId, lines) ?? true;
    }
    if (draft.parentId) {
      return this.prepareDraft(rowId, '', [])?.controller.createMany(rowId, lines) ?? true;
    }
    const byOrg = new Map<string, string[]>();
    const missing = new Set<string>();
    for (const line of lines) {
      const target = this.draftTarget(rowId, line, []);
      const state = target.org && this.controllerOf(target.org.id)?.state();
      if (!target.org || !state || !inboxOf(state)) {
        missing.add(target.org?.name ?? '');
        continue;
      }
      byOrg.set(target.org.id, [...(byOrg.get(target.org.id) ?? []), target.text]);
    }
    if (missing.size > 0) {
      toast({
        message: this.deps.t('all.pasteUnavailable', { org: [...missing].join(', ') }),
        tone: 'danger',
      });
      return false;
    }
    let first = true;
    for (const [orgId, orgLines] of byOrg) {
      const controller = this.controllerOf(orgId) as ListController;
      const state = controller.state() as ListState;
      const groupId = state.groups[draft.groupId] ? draft.groupId : (inboxOf(state)?.id ?? '');
      // The first org takes the new row; each further org gets one in the same place.
      const id = first ? rowId : uuidv7();
      if (first) this.ui().updateDraft(rowId, { groupId });
      else this.ui().addDraft({ ...draft, id, groupId });
      first = false;
      controller.createMany(id, orgLines);
    }
    return true;
  }

  // -------------------------------------------------------------------------------------
  // One org's commands: tags, people, groups
  // -------------------------------------------------------------------------------------

  override toggleTag(ids: readonly string[], tagId: string): void {
    const scoped = this.scoped(ids);
    if (scoped) scoped.toggleTag(ids, tagId);
    else this.oneOrgOnly();
  }

  override removeTag(taskId: string, tagId: string): void {
    this.scoped([taskId])?.removeTag(taskId, tagId);
  }

  override createTagFor(ids: readonly string[], name: string): string | null {
    const scoped = this.scoped(ids);
    if (scoped) return scoped.createTagFor(ids, name);
    this.oneOrgOnly();
    return null;
  }

  override assign(ids: readonly string[], assigneeId: string | null): boolean {
    const scoped = this.scoped(ids);
    return scoped ? scoped.assign(ids, assigneeId) : this.oneOrgOnly();
  }

  override moveToGroup(groupId: string, ids: readonly string[] = this.selectedTaskIds()): void {
    const scoped = this.scoped(ids);
    if (scoped && scoped.orgId === this.orgOfGroup(groupId)) scoped.moveToGroup(groupId, ids);
    else this.ui().set({ popover: null });
  }

  override makeSubtaskOf(ids: readonly string[], parentId: string): boolean {
    const org = this.orgOfTask(parentId);
    const same = ids.filter((id) => this.orgOfTask(id) === org);
    if (same.length < ids.length) this.oneOrgOnly();
    return same.length > 0 && (this.controllerOf(org)?.makeSubtaskOf(same, parentId) ?? false);
  }

  /** Moving to another organisation is the pane's in All organisations (ADR 0072). */
  override movesToOrg(): boolean {
    return false;
  }

  override movableToOrg(): string[] {
    return [];
  }

  override moveToOrg(): boolean {
    return false;
  }
}
