import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Circle,
  CircleCheck,
  Command,
  ListTodo,
  type LucideIcon,
  Rows3,
  Search,
  WifiOff,
} from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react';
import { ToggleButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { PaletteGroup } from '../../keymap';
import { cn } from '../../lib/cn';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { DateLabel, type ViewerDateContext } from '../dates';
import {
  type ActionItem,
  flatItems,
  type GuideItem,
  type PaletteItem,
  type PaletteSection,
  type Segment,
  stepActiveKey,
  type TaskChip,
  type TaskItem,
} from './model';

export type PaletteVariant = 'floating' | 'sheet' | 'static';

/** The "All organisations" toggle; off searches the current org (named in the placeholder). */
export interface PaletteScope {
  allOrgs: boolean;
  onChange: (allOrgs: boolean) => void;
}

export interface PalettePanelProps {
  /** `floating`: the centred desktop panel; `sheet`: the phone's full screen; `static`: docs. */
  variant: PaletteVariant;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  sections: readonly PaletteSection[];
  activeKey: string | null;
  onActiveKeyChange: (key: string | null) => void;
  onSelect: (item: PaletteItem) => void;
  onClose: () => void;
  /** A second step (the "Make subtask of…" picker): its title and the way back. */
  step?: { title: string; onBack: () => void } | undefined;
  /** Results come from the cache (02 §12: offline, or the search failed). */
  offline?: boolean;
  /** A search is in flight (the previous results stay). */
  loading?: boolean;
  /** Shown when the query has no results; null hides it (e.g. while loading). */
  emptyText?: string | null | undefined;
  /** Current org or every org (FR-VIEW-3); hidden without an org in context. */
  scope?: PaletteScope | undefined;
  dateCtx: ViewerDateContext;
  /** The phone keyboard's height (`useKeyboardInset`), so the last results stay reachable. */
  keyboardInset?: number;
}

const groupIcons: Record<PaletteGroup, LucideIcon> = {
  task: ListTodo,
  list: Rows3,
  navigation: ArrowRight,
  general: Command,
};

function Highlighted({ segments }: { segments: readonly Segment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.mark ? (
          <mark key={i} className="rounded-2xs bg-bg-accent-subtle font-medium text-text">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function Shortcut({ keys }: { keys: string }) {
  // `G T` sequences show as two keys, like the cheat sheet.
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.split(' ').map((part, i) => (
        <Fragment key={part}>
          {i > 0 && <span className="sr-only"> </span>}
          <Kbd shortcut={part} />
        </Fragment>
      ))}
    </span>
  );
}

/** The group, org or guide page of a result, muted and outlined like the smart views' chip. */
function ResultChip({ chip }: { chip: TaskChip | { kind: 'page'; name: string } }) {
  const { t } = useTranslation('palette');
  return (
    <span
      data-testid="palette-chip"
      data-kind={chip.kind}
      className="inline-flex h-chip max-w-date-cell shrink-0 items-center rounded-xs border border-border px-1.5 text-xs text-text-muted"
    >
      <span className="sr-only">{t(`chip.${chip.kind}`, { name: chip.name })}</span>
      <span aria-hidden className="truncate">
        {chip.name}
      </span>
    </span>
  );
}

function TaskOption({ item, dateCtx }: { item: TaskItem; dateCtx: ViewerDateContext }) {
  const { task } = item;
  const done = task.completedAt !== null;
  const Icon = done ? CircleCheck : Circle;
  return (
    <>
      <Icon
        className={cn('size-4 shrink-0', done ? 'text-check-done' : 'text-text-muted')}
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn('min-w-0 shrink truncate', done && 'text-text-secondary')}>
          <Highlighted segments={item.title} />
        </span>
        {item.snippet && (
          <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
            <Highlighted segments={item.snippet} />
          </span>
        )}
      </span>
      {item.chip && <ResultChip chip={item.chip} />}
      <DateLabel
        value={task}
        ctx={dateCtx}
        completed={done}
        tooltip={false}
        className="shrink-0 text-sm"
      />
    </>
  );
}

function GuideOption({ item }: { item: GuideItem }) {
  return (
    <>
      <BookOpen
        className="size-4 shrink-0 text-text-muted"
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2" lang={item.lang}>
        <span className="min-w-0 shrink-0 truncate">
          <Highlighted segments={item.title} />
        </span>
        {item.snippet.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
            <Highlighted segments={item.snippet} />
          </span>
        )}
      </span>
      {item.page && <ResultChip chip={{ kind: 'page', name: item.page }} />}
    </>
  );
}

function ActionOption({ item }: { item: ActionItem }) {
  const Icon = groupIcons[item.group];
  return (
    <>
      <Icon className="size-4 shrink-0 text-text-muted" strokeWidth={iconStrokeWidth} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.shortcut && <Shortcut keys={item.shortcut} />}
    </>
  );
}

/**
 * The command palette surface (02 §12, 03 §3.11): a search field over grouped results, an ARIA
 * combobox whose listbox keeps focus in the field (`aria-activedescendant`). Stateless: the
 * container owns the query, the results and what an item does.
 */
export function PalettePanel({
  variant,
  query,
  onQueryChange,
  placeholder,
  sections,
  activeKey,
  onActiveKeyChange,
  onSelect,
  onClose,
  step,
  offline = false,
  loading = false,
  emptyText,
  scope,
  dateCtx,
  keyboardInset = 0,
}: PalettePanelProps) {
  const { t } = useTranslation('palette');
  const baseId = useId();
  const input = useRef<HTMLInputElement>(null);
  const listId = `${baseId}-list`;
  const items = useMemo(() => flatItems(sections), [sections]);
  const optionId = (key: string) => `${baseId}-o${items.findIndex((i) => i.key === key)}`;
  const active = items.find((i) => i.key === activeKey) ?? null;
  const sheet = variant === 'sheet';

  useEffect(() => {
    if (variant !== 'static') input.current?.focus({ preventScroll: true });
  }, [variant]);

  useEffect(() => {
    if (!activeKey) return;
    const index = items.findIndex((i) => i.key === activeKey);
    document.getElementById(`${baseId}-o${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey, items, baseId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        onActiveKeyChange(stepActiveKey(sections, activeKey, event.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'Enter':
        event.preventDefault();
        if (active) onSelect(active);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      case 'Backspace':
        if (step && query === '') {
          event.preventDefault();
          step.onBack();
        }
        return;
    }
  };

  const count = items.length;
  const status = offline
    ? t('status.offline')
    : count > 0
      ? t('status.results', { count })
      : (emptyText ?? '');

  let index = -1;
  const body = (
    <>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-b border-border',
          sheet ? 'h-sheet-header ps-2 pe-2' : 'h-toolbar ps-4 pe-2',
        )}
      >
        {step ? (
          <IconButton
            icon={ArrowLeft}
            aria-label={t('picker.back')}
            onPress={step.onBack}
            className={sheet ? 'size-hit-touch' : undefined}
          />
        ) : (
          <Search
            className={cn('size-4 shrink-0 text-text-muted', sheet && 'ms-2')}
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        )}
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={step?.title ?? t('label')}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active.key) : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={step?.title ?? placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="palette-input"
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent text-md text-text outline-none placeholder:text-text-muted',
          )}
        />
        {scope && !step && (
          <ToggleButton
            isSelected={scope.allOrgs}
            onChange={scope.onChange}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'shrink-0 data-selected:bg-bg-muted data-selected:text-text',
            )}
            data-testid="palette-scope"
          >
            {t('scope.all')}
          </ToggleButton>
        )}
        {sheet && (
          <Button variant="ghost" onPress={onClose} className="h-hit-touch">
            {t('cancel')}
          </Button>
        )}
      </div>
      {offline && (
        <p
          className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-text-muted"
          data-testid="palette-offline"
        >
          <WifiOff className="size-3.5 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
          {t('status.offline')}
        </p>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={t('results')}
        aria-busy={loading || undefined}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain py-1',
          count === 0 && 'hidden',
        )}
        style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      >
        {sections.map((section) => {
          const headingId = `${baseId}-${section.id}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group".
            <div key={section.id} role="group" aria-labelledby={headingId}>
              <div
                id={headingId}
                role="presentation"
                className="px-4 pt-2 pb-1 text-xs font-semibold text-text-muted"
              >
                {t(`section.${section.id}`)}
              </div>
              {section.items.map((item) => {
                index += 1;
                const isActive = item.key === activeKey;
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: options are reached with aria-activedescendant; focus and keys stay in the combobox input.
                  <div
                    key={item.key}
                    id={`${baseId}-o${index}`}
                    role="option"
                    aria-selected={isActive}
                    data-testid={`palette-${item.kind}`}
                    data-key={item.key}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => {
                      if (!isActive) onActiveKeyChange(item.key);
                    }}
                    onClick={() => onSelect(item)}
                    className={cn(
                      'relative flex cursor-default items-center gap-3 px-4 text-base text-text',
                      sheet ? 'min-h-hit-touch py-1' : 'h-row',
                      // 03 §3.11 says bg-muted, but the due-date colours fail 4.5:1 on it
                      // (date-today: 4.4:1); bg-subtle passes, and the accent bar marks it.
                      isActive &&
                        'bg-bg-subtle before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full before:bg-bg-accent',
                    )}
                  >
                    {item.kind === 'task' ? (
                      <TaskOption item={item} dateCtx={dateCtx} />
                    ) : item.kind === 'guide' ? (
                      <GuideOption item={item} />
                    ) : (
                      <ActionOption item={item} />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {count === 0 && emptyText && (
        <div
          className="flex flex-col items-center gap-1 px-4 py-8 text-center"
          data-testid="palette-empty"
        >
          <p className="text-sm text-text-secondary">{emptyText}</p>
          {!offline && query.trim() !== '' && (
            <p className="text-xs text-text-muted">{t('empty.hint')}</p>
          )}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
    </>
  );

  return <PaletteFrame variant={variant} label={t('title')} onClose={onClose} body={body} />;
}

interface PaletteFrameProps {
  variant: PaletteVariant;
  label: string;
  onClose: () => void;
  body: ReactNode;
}

/**
 * Non-modal (02 §12): the backdrop is transparent and a click on it closes the palette; focus
 * leaving the panel closes it too. On phones it fills the screen like the detail sheet.
 */
function PaletteFrame({ variant, label, onClose, body }: PaletteFrameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !panel.current?.contains(next)) onClose();
  };
  if (variant === 'static') {
    return (
      <section
        aria-label={label}
        className="flex max-h-[60dvh] w-full max-w-palette flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-lg"
      >
        {body}
      </section>
    );
  }
  const sheet = variant === 'sheet';
  return (
    <>
      {!sheet && (
        <div
          aria-hidden
          data-testid="palette-backdrop"
          className="fixed inset-0 z-(--z-palette)"
          onPointerDown={(event) => {
            event.preventDefault();
            onClose();
          }}
        />
      )}
      <div
        ref={panel}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        data-overlay
        data-testid="palette"
        onBlur={onBlur}
        className={cn(
          'fixed z-(--z-palette) flex flex-col overflow-hidden bg-bg-elevated text-text',
          sheet
            ? 'inset-0 pt-safe animate-sheet-in motion-reduce:animate-fade-in'
            : 'inset-x-3 top-16 max-h-[60dvh] rounded-lg border border-border shadow-lg animate-popover-in motion-reduce:animate-fade-in tablet:inset-x-auto tablet:left-1/2 tablet:w-palette tablet:-translate-x-1/2',
        )}
      >
        {body}
      </div>
    </>
  );
}
