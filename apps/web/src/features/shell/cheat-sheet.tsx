import { X } from 'lucide-react';
import { Fragment, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import {
  isKeyed,
  type KeyedShortcutId,
  keymap,
  type ShortcutDefinition,
  type ShortcutSection,
  shortcutIds,
} from '../../keymap';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';

export const useCheatSheet = create<{ open: boolean }>()(() => ({ open: false }));

export function toggleCheatSheet(open?: boolean): void {
  useCheatSheet.setState((s) => ({ open: open ?? !s.open }));
}

const sections: readonly ShortcutSection[] = [
  'general',
  'navigation',
  'editing',
  'moving',
  'groups',
  'pane',
  'editor',
  'dates',
  'inbox',
];

/**
 * Registry entries per section, in registry order (the docs are generated, 02 §6). Palette-only
 * commands have no keys and are left out.
 */
export function cheatSheetSections(): { section: ShortcutSection; ids: KeyedShortcutId[] }[] {
  const keyed = shortcutIds.filter(isKeyed);
  return sections.map((section) => ({
    section,
    ids: keyed.filter((id) => keymap[id].section === section),
  }));
}

function Keys({ definition }: { definition: ShortcutDefinition }) {
  const alternatives = definition.display ? [definition.display] : definition.keys;
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {alternatives.map((keys, i) => (
        <Fragment key={keys}>
          {i > 0 && <span className="text-xs text-text-muted">/</span>}
          {keys.split(' ').map((part, j) => (
            <Fragment key={part}>
              {j > 0 && <span className="sr-only"> </span>}
              <Kbd shortcut={part} />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * `?` (02 §6): the shortcut cheat sheet, generated from the keymap registry. A non-modal
 * overlay: the list stays usable, Esc or ✕ closes it.
 */
export function CheatSheet() {
  const { t } = useTranslation('list');
  const open = useCheatSheet((s) => s.open);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toggleCheatSheet(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={t('cheatSheet.title')}
      data-overlay
      className={cn(
        'fixed inset-x-3 bottom-3 z-(--z-popover) flex max-h-[80dvh] flex-col rounded-lg border border-border bg-bg-elevated shadow-lg outline-none',
        'animate-popover-in motion-reduce:animate-fade-in tablet:inset-x-auto tablet:right-6 tablet:bottom-6 tablet:w-palette',
      )}
    >
      <header className="flex h-toolbar shrink-0 items-center justify-between border-b border-border ps-4 pe-2">
        <h2 className="text-base font-semibold">{t('cheatSheet.title')}</h2>
        <IconButton
          icon={X}
          aria-label={t('cheatSheet.close')}
          shortcut="Escape"
          onPress={() => toggleCheatSheet(false)}
        />
      </header>
      <div className="grid gap-x-8 gap-y-6 overflow-y-auto p-4 tablet:grid-cols-2">
        {cheatSheetSections().map(({ section, ids }) => (
          <section key={section} className="flex flex-col gap-1">
            <h3 className="pb-1 text-xs font-semibold text-text-muted">
              {t(`keys.section.${section}`)}
            </h3>
            <dl className="flex flex-col">
              {ids.map((id) => (
                <div
                  key={id}
                  className="flex min-h-control items-center justify-between gap-4 text-sm"
                >
                  <dt className="text-text-secondary">{t(`keys.${id}`)}</dt>
                  <dd>
                    <Keys definition={keymap[id]} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
  );
}
