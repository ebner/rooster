import { useNavigate } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { Fragment, type KeyboardEvent, useMemo } from 'react';
import { Button as AriaButton, Link as AriaLink, SearchField } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { Input } from '../../ui/input';
import { paths } from '../shell/paths';
import type { GuidePage } from './guide-model';
import { type Highlighted, searchGuide } from './guide-search';

/** The guide's search (ADR 0058): the query lives in the URL as `?q=`. */
export interface GuideSearchState {
  query: string;
  onQueryChange: (query: string) => void;
}

export const guideResultsId = 'guide-search-results';

/**
 * The search state of the current help route. Typing replaces the URL rather than adding an
 * entry, so Back from a result returns to the results as they were.
 */
export function useGuideSearch(q: string | undefined): GuideSearchState {
  const navigate = useNavigate();
  return {
    query: q ?? '',
    onQueryChange: (query) =>
      void navigate({
        to: '.',
        search: query ? { q: query } : {},
        replace: true,
      }),
  };
}

/** Whether `query` shows results instead of the page. */
export function isSearching(query: string | undefined): boolean {
  return (query ?? '').trim() !== '';
}

const firstResult = () =>
  document.getElementById(guideResultsId)?.querySelector<HTMLAnchorElement>('a[href]') ?? null;

/** The search field: ↓ moves to the results, Enter opens the first one, Esc clears it. */
export function GuideSearchField({
  query,
  onQueryChange,
  className,
}: GuideSearchState & { className?: string }) {
  const { t } = useTranslation('help');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowDown') return;
    const link = firstResult();
    if (!link) return;
    event.preventDefault();
    link.focus();
  };
  return (
    <SearchField
      aria-label={t('search.label')}
      value={query}
      onChange={onQueryChange}
      onSubmit={() => firstResult()?.click()}
      className={cn('group relative flex items-center', className)}
      data-testid="guide-search"
    >
      <Search
        className="pointer-events-none absolute start-3 size-4 text-text-muted"
        strokeWidth={iconStrokeWidth}
        aria-hidden
      />
      <Input
        placeholder={t('search.placeholder')}
        aria-controls={isSearching(query) ? guideResultsId : undefined}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        className="ps-10 pe-10 [&::-webkit-search-cancel-button]:hidden"
      />
      <AriaButton
        aria-label={t('search.clear')}
        className={cn(
          'absolute end-2 flex size-6 cursor-default items-center justify-center rounded-xs text-text-muted',
          'outline-none hover:bg-bg-subtle hover:text-text focus-ring:outline-2 focus-ring:outline-border-focus',
          'pointer-coarse:size-hit-touch pointer-coarse:end-0 group-data-empty:hidden',
        )}
      >
        <X className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
      </AriaButton>
    </SearchField>
  );
}

function Marked({ parts }: { parts: readonly Highlighted[] }) {
  return parts.map((part, i) =>
    part.match ? (
      <mark key={i} className="rounded-2xs bg-bg-accent-subtle font-medium text-text">
        {part.text}
      </mark>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  );
}

/** The sections that match `query`, each a link to its page and heading. */
export function GuideSearchResults({
  pages,
  query,
}: {
  pages: readonly GuidePage[];
  query: string;
}) {
  const { t } = useTranslation('help');
  const results = useMemo(() => searchGuide(pages, query), [pages, query]);
  return (
    <section
      id={guideResultsId}
      aria-label={t('search.results')}
      className="flex guide-measure flex-col gap-4"
      data-testid="guide-search-results"
    >
      <p role="status" className="text-sm text-text-muted">
        {results.length > 0
          ? t('search.count', { count: results.length })
          : t('search.none', { query: query.trim() })}
      </p>
      {results.length > 0 && (
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
          {results.map(({ section, title, snippet }) => (
            <li key={`${section.slug}#${section.id ?? ''}`} lang={section.lang}>
              <AriaLink
                href={`${paths.helpPage(section.slug)}${section.id ? `#${section.id}` : ''}`}
                className={cn(
                  'flex min-h-hit-touch cursor-default flex-col gap-1 px-4 py-3 -outline-offset-2',
                  'rounded-sm outline-none focus-ring:outline-2 focus-ring:outline-border-focus',
                  'transition-colors duration-(--dur-fast) ease-standard hover:bg-bg-subtle pressed:bg-bg-muted',
                )}
              >
                {section.heading !== null && (
                  <span className="text-xs text-text-muted">{section.pageTitle}</span>
                )}
                <span className="text-md text-text">
                  <Marked parts={title} />
                </span>
                {snippet.length > 0 && (
                  <span className="line-clamp-2 text-sm text-text-secondary">
                    <Marked parts={snippet} />
                  </span>
                )}
              </AriaLink>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
