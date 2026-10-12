import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Skeleton } from '../../ui/skeleton';
import { paths } from '../shell/paths';
import { type GuidePage, neighbours } from './guide-model';
import {
  GuideSearchField,
  GuideSearchResults,
  type GuideSearchState,
  isSearching,
} from './guide-search-view';
import './guide.css';

const linkClass = cn(
  'rounded-sm outline-none focus-ring:outline-2 focus-ring:outline-border-focus',
  'transition-colors duration-(--dur-fast) ease-standard',
);

/** `/help`: every page of the guide, in order, and the search over them. */
export function GuideIndex({
  pages,
  search,
}: {
  pages: readonly GuidePage[];
  search?: GuideSearchState | undefined;
}) {
  const { t } = useTranslation('help');
  const searching = isSearching(search?.query);
  return (
    <div className="flex max-w-pane-max flex-col gap-6" data-testid="guide-index">
      <p className="text-md text-text-secondary">{t('lead')}</p>
      {search && <GuideSearchField {...search} />}
      {searching && search && <GuideSearchResults pages={pages} query={search.query} />}
      <nav aria-label={t('pages')} hidden={searching}>
        <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
          {pages.map((page, index) => (
            <li key={page.slug}>
              <AriaLink
                href={paths.helpPage(page.slug)}
                className={cn(
                  linkClass,
                  'flex min-h-hit-touch cursor-default items-center gap-3 px-4 py-2 -outline-offset-2',
                  'hover:bg-bg-subtle pressed:bg-bg-muted',
                )}
              >
                <span className="w-6 shrink-0 text-end text-sm text-text-muted tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-md" lang={page.lang}>
                  {page.title}
                </span>
                <ArrowRight
                  className="size-4 shrink-0 text-text-muted rtl:-scale-x-100"
                  strokeWidth={iconStrokeWidth}
                  aria-hidden
                />
              </AriaLink>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

export interface GuideArticleProps {
  page: GuidePage;
  pages: readonly GuidePage[];
  /** The viewer's language: a page in another language says so. */
  locale: string;
  /** In-app navigation for links between guide pages (`/help/<slug>#anchor`). */
  onNavigate: (href: string) => void;
  /** URL fragment to scroll to after rendering (an anchor on the page). */
  hash?: string | undefined;
  /** On mount and page change, scroll to the article (or its anchor) and focus it (the route). */
  autoFocus?: boolean;
  /** The search above the page list (desktop); a query shows its results instead of the page. */
  search?: GuideSearchState | undefined;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^#/, ''));
  } catch {
    return value.replace(/^#/, '');
  }
}

/** Wide tables that scroll get a tab stop, so keyboard users can scroll them (WCAG 2.1.1). */
function markScrollableTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll<HTMLElement>('.guide-table')) {
    if (table.scrollWidth > table.clientWidth) table.tabIndex = 0;
    else table.removeAttribute('tabindex');
  }
}

/**
 * One page of the guide (ADR 0052 §2): build-time HTML from the repository's Markdown, the
 * page list beside it on wide screens, and the previous and next page below it.
 */
export function GuideArticle({
  page,
  pages,
  locale,
  onNavigate,
  hash,
  autoFocus = false,
  search,
}: GuideArticleProps) {
  const { t } = useTranslation('help');
  const article = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { previous, next } = neighbours(pages, page.slug);
  const searching = isSearching(search?.query);

  // A new page: focus lands on the article (announced by its title) and the view starts at
  // its top, or at the anchor the link named. The article stays mounted under the search
  // results; when they close the same happens, unless the field keeps focus (Esc, clear).
  useEffect(() => {
    const root = article.current;
    if (!root || !autoFocus) return;
    if (searching) {
      document.querySelector('[data-scroll-main]')?.scrollTo({ top: 0 });
      return;
    }
    if (document.activeElement?.closest('[data-testid="guide-search"]')) {
      root.scrollIntoView({ block: 'start' });
      return;
    }
    const target = hash ? document.getElementById(decodeFragment(hash)) : null;
    if (target && root.contains(target)) {
      target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
      return;
    }
    root.scrollIntoView({ block: 'start' });
    root.focus({ preventScroll: true });
  }, [page.slug, hash, autoFocus, searching]);

  useEffect(() => {
    const root = body.current;
    if (!root) return;
    markScrollableTables(root);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => markScrollableTables(root));
    observer.observe(root);
    return () => observer.disconnect();
  }, [page.html]);

  // Links between pages route in the app; in-page anchors scroll and take focus. Enter on a
  // link fires the same click, so the keyboard path is the link itself.
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      const href = link?.getAttribute('href');
      if (!link || !href) return;
      if (link.hasAttribute('data-guide-link')) {
        event.preventDefault();
        navigate.current(href);
      } else if (href.startsWith('#')) {
        event.preventDefault();
        const target = document.getElementById(decodeFragment(href));
        if (!target) return;
        target.tabIndex = -1;
        target.scrollIntoView({ block: 'start' });
        target.focus({ preventScroll: true });
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, []);

  return (
    <div className="flex flex-col gap-8 desktop:flex-row desktop:items-start desktop:gap-12">
      <GuideNav pages={pages} current={page.slug} search={search} />
      {searching && search && (
        <div className="min-w-0 flex-1">
          <GuideSearchResults pages={pages} query={search.query} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-10" hidden={searching}>
        <article
          ref={article}
          tabIndex={-1}
          aria-label={page.title}
          lang={page.lang}
          className="flex scroll-mt-16 flex-col gap-4 rounded-sm outline-none focus-ring:outline-2 focus-ring:outline-offset-4 focus-ring:outline-border-focus"
          data-testid="guide-article"
          data-slug={page.slug}
        >
          {page.lang !== locale && (
            <Banner tone="info" className="guide-measure">
              <span lang={locale}>{t('fallback')}</span>
            </Banner>
          )}
          {/* Trusted HTML rendered at build time from docs/guide (ADR 0052 §2); no user content. */}
          <div ref={body} className="guide-prose" dangerouslySetInnerHTML={{ __html: page.html }} />
        </article>
        <PageSteps previous={previous} next={next} />
      </div>
    </div>
  );
}

/**
 * The search and the list of pages beside the article (desktop); phones go back to the index,
 * which has both.
 */
function GuideNav({
  pages,
  current,
  search,
}: {
  pages: readonly GuidePage[];
  current: string;
  search: GuideSearchState | undefined;
}) {
  const { t } = useTranslation('help');
  return (
    <div className="flex shrink-0 flex-col gap-3 max-desktop:hidden desktop:sticky desktop:top-(--space-16) desktop:w-sidebar">
      {search && <GuideSearchField {...search} />}
      <nav aria-label={t('pages')}>
        <ul className="flex flex-col gap-0.5">
          {pages.map((page) => {
            const active = page.slug === current;
            return (
              <li key={page.slug}>
                <AriaLink
                  href={paths.helpPage(page.slug)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    linkClass,
                    'flex min-h-control cursor-default items-center px-3 py-1 text-sm',
                    active
                      ? 'bg-bg-selected font-medium text-text'
                      : 'text-text-secondary hover:bg-bg-subtle hover:text-text',
                  )}
                >
                  <span lang={page.lang}>{page.title}</span>
                </AriaLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function PageSteps({
  previous,
  next,
}: {
  previous: GuidePage | undefined;
  next: GuidePage | undefined;
}) {
  const { t } = useTranslation('help');
  const step = (page: GuidePage, direction: 'previous' | 'next') => (
    <AriaLink
      href={paths.helpPage(page.slug)}
      rel={direction === 'previous' ? 'prev' : 'next'}
      className={cn(
        linkClass,
        'flex min-h-hit-touch min-w-0 flex-1 cursor-default flex-col justify-center gap-0.5 border border-border px-4 py-2',
        'hover:bg-bg-subtle pressed:bg-bg-muted',
        direction === 'next' && 'items-end text-end',
      )}
    >
      <span className="flex items-center gap-1 text-xs text-text-muted">
        {direction === 'previous' && (
          <ArrowLeft
            className="size-4 rtl:-scale-x-100"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        )}
        {t(direction)}
        {direction === 'next' && (
          <ArrowRight
            className="size-4 rtl:-scale-x-100"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        )}
      </span>
      <span className="max-w-full truncate text-md text-text" lang={page.lang}>
        {page.title}
      </span>
    </AriaLink>
  );
  return (
    <nav aria-label={t('steps')} className="flex guide-measure flex-col gap-3 tablet:flex-row">
      {previous ? step(previous, 'previous') : <span className="flex-1 max-tablet:hidden" />}
      {next ? step(next, 'next') : <span className="flex-1 max-tablet:hidden" />}
    </nav>
  );
}

/** An unknown slug: said in place, with the way back to the page list. */
export function GuideNotFound() {
  const { t } = useTranslation('help');
  return (
    <div className="flex max-w-pane-max flex-col items-start gap-3" data-testid="guide-not-found">
      <h2 className="text-lg">{t('notFound.title')}</h2>
      <p className="text-md text-text-secondary">{t('notFound.body')}</p>
      <AriaLink
        href={paths.help}
        className={cn(
          linkClass,
          'inline-flex items-center gap-2 text-sm text-text-accent underline-offset-2 hover:underline',
        )}
      >
        <BookOpen className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        {t('notFound.back')}
      </AriaLink>
    </div>
  );
}

/** While the guide's chunk loads, or when it failed (offline before it was cached). */
export function GuideStatus({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('help');
  if (error) {
    return (
      <div className="flex max-w-pane-max flex-col items-start gap-3">
        <Banner tone="danger" role="alert">
          {t('loadFailed')}
        </Banner>
        <Button size="sm" onPress={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex max-w-pane-max flex-col gap-3" role="status" aria-label={t('loading')}>
      <Skeleton className="h-row w-1/2" />
      <Skeleton className="h-row w-full" />
      <Skeleton className="h-row w-3/4" />
    </div>
  );
}
