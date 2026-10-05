import type { Org } from '../../data/types';
import {
  type PaletteCommandId,
  paletteCommandIds,
  paletteGroupOf,
  primaryKeys,
  type ShortcutId,
} from '../../keymap';
import { orgUrlSlug, paths } from '../shell/paths';
import type { ActionItem } from './model';

export interface ActionContext {
  orgs: readonly Org[];
  /** The org in the URL, if any. */
  currentOrg: Org | null;
  isAdmin: boolean;
  /** The list publishes a non-empty selection (`currentPaletteCommands()`). */
  hasSelection: boolean;
  /** The list publishes `makeSubtaskOf` for that selection. */
  canMakeSubtask: boolean;
  /** Phones have no sidebar to toggle. */
  phone: boolean;
  /** A mounted screen handles the command (`hasShortcutHandler`). */
  isAvailable: (id: ShortcutId) => boolean;
  label: (id: PaletteCommandId) => string;
  goToOrgLabel: (name: string) => string;
}

/** Org views that need an org to go to (the current one, else the first). */
const orgViews = new Set<ShortcutId>(['goMyTasks', 'goToday', 'goWeek', 'goOverdue', 'goNoDate']);

function visible(id: PaletteCommandId, ctx: ActionContext): boolean {
  switch (paletteGroupOf(id)) {
    case 'task':
      if (!ctx.hasSelection) return false;
      return id === 'makeSubtaskOf' ? ctx.canMakeSubtask : ctx.isAvailable(id);
    case 'list':
      return ctx.isAvailable(id);
    case 'general':
      if (id === 'toggleSidebar') return !ctx.phone;
      return ctx.isAvailable(id);
    default:
      if (orgViews.has(id)) return ctx.orgs.length > 0;
      if (id === 'openOrgSettings') return ctx.currentOrg !== null;
      if (id === 'openAdmin') return ctx.isAdmin;
      return true;
  }
}

/**
 * The palette's actions (FR-VIEW-4), generated from the keymap registry (04 §5.3): every entry
 * with a `palette` group that applies right now, plus one "Go to <org>" per org (Mod+1…9).
 * Each shows the registry's first binding.
 */
export function buildActions(ctx: ActionContext): ActionItem[] {
  const out: ActionItem[] = [];
  for (const id of paletteCommandIds) {
    if (!visible(id, ctx)) continue;
    const shortcut = primaryKeys(id);
    out.push({
      kind: 'action',
      key: `action:${id}`,
      commandId: id,
      group: paletteGroupOf(id) ?? 'general',
      label: ctx.label(id),
      shortcut: shortcut === '' ? null : shortcut,
    });
    if (id === 'goMyTasks') out.push(...orgActions(ctx));
  }
  return out;
}

function orgActions(ctx: ActionContext): ActionItem[] {
  return ctx.orgs.map((org, index) => {
    const digit = String(index + 1);
    const keyed = index < 9;
    return {
      kind: 'action',
      key: `action:goToOrg:${org.id}`,
      commandId: 'goToOrg',
      group: 'navigation',
      label: ctx.goToOrgLabel(org.name),
      shortcut: keyed ? `Mod+${digit}` : null,
      args: keyed ? { key: digit, code: `Digit${digit}` } : undefined,
      href: paths.orgView(orgUrlSlug(org), 'my'),
    };
  });
}
