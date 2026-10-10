import { BookOpen, X } from 'lucide-react';
import { Fragment, useEffect, useId, useRef } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { keyedShortcutsBySection, keymap, type ShortcutDefinition } from '../../keymap';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { paths } from './paths';

export const useCheatSheet = create<{ open: boolean }>()(() => ({ open: false }));

export function toggleCheatSheet(open?: boolean): void {
  useCheatSheet.setState((s) => ({ open: open ?? !s.open }));
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
  const { t: th } = useTranslation('help');
  const titleId = useId();
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
        <h2 id={titleId} className="text-base font-semibold">
          {t('cheatSheet.title')}
        </h2>
        <IconButton
          icon={X}
          aria-label={t('cheatSheet.close')}
          shortcut="Escape"
          onPress={() => toggleCheatSheet(false)}
        />
      </header>
      {/* Scrolls with the keyboard too (WCAG 2.1.1): the region takes focus. */}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard.
        tabIndex={0}
        aria-labelledby={titleId}
        className="grid gap-x-8 gap-y-6 overflow-y-auto rounded-b-lg p-4 -outline-offset-2 outline-none focus-ring:outline-2 focus-ring:outline-border-focus tablet:grid-cols-2"
      >
        {keyedShortcutsBySection().map(({ section, ids }) => (
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
      </section>
      <footer className="flex shrink-0 items-center border-t border-border px-2 py-1">
        <AriaLink
          href={paths.help}
          onPress={() => toggleCheatSheet(false)}
          className="inline-flex h-control items-center gap-2 rounded-sm px-2 text-sm text-text-secondary outline-none hover:bg-bg-subtle hover:text-text focus-ring:outline-2 focus-ring:outline-border-focus"
        >
          <BookOpen className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          {th('open')}
        </AriaLink>
      </footer>
    </aside>
  );
}
