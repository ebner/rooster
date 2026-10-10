import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { fixtureGuidePages } from './fixtures';
import { loadGuide, useGuide } from './guide-content';
import { type GuidePage, neighbours } from './guide-model';
import { GuideArticle, GuideIndex, GuideNotFound, GuideStatus } from './guide-view';

vi.mock('virtual:rooster-guide/en', () => ({
  pages: [{ slug: 'getting-started', title: 'Getting started', lang: 'en', html: '<p>Hi</p>' }],
}));
vi.mock('virtual:rooster-guide/sv', () => ({
  pages: [{ slug: 'getting-started', title: 'Kom igång', lang: 'sv', html: '<p>Hej</p>' }],
}));

const pages = fixtureGuidePages;
const reminders = pages.find((p) => p.slug === 'reminders') as GuidePage;

function article(props: Partial<Parameters<typeof GuideArticle>[0]> = {}) {
  const onNavigate = vi.fn();
  render(
    <GuideArticle page={reminders} pages={pages} locale="en" onNavigate={onNavigate} {...props} />,
  );
  return { onNavigate };
}

describe('the in-app guide (AC-11.6)', () => {
  test('the article renders the build-time HTML with its headings, table and image', () => {
    article();
    const body = screen.getByTestId('guide-article');
    expect(body.getAttribute('aria-label')).toBe('Reminders');
    expect(within(body).getByRole('heading', { level: 2, name: 'Add a reminder' })).toBeTruthy();
    expect(within(body).getByRole('table')).toBeTruthy();
    expect(within(body).getByRole('img').getAttribute('alt')).toBe(
      'The date picker with its reminder section open',
    );
    expect(screen.queryByText(/isn’t translated yet/)).toBeNull();
  });

  test('a link to another page routes in the app; modified clicks and external links do not', () => {
    const { onNavigate } = article();
    const body = screen.getByTestId('guide-article');
    const internal = within(body).getByRole('link', { name: 'Settings and your data' });
    expect(fireEvent.click(internal)).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith('/help/settings-and-data');
    fireEvent.click(internal, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const external = within(body).getByRole('link', { name: 'the project on GitHub' });
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fireEvent.click(external)).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  test('previous and next pages, and the page list marks the current page', () => {
    article();
    const steps = screen.getByRole('navigation', { name: 'Previous and next page' });
    const links = within(steps).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/help/my-tasks', '/help/keyboard']);
    const list = screen.getByRole('navigation', { name: 'Guide pages' });
    const current = within(list).getByRole('link', { name: 'Reminders' });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  test('autoFocus moves focus to the article (route navigation)', () => {
    Element.prototype.scrollIntoView = vi.fn();
    article({ autoFocus: true });
    expect(document.activeElement).toBe(screen.getByTestId('guide-article'));
  });

  test('a page shown in English for a Swedish reader says so', () => {
    article({ locale: 'sv' });
    expect(
      screen.getByText('This page isn’t translated yet, so it’s shown in English.'),
    ).toBeTruthy();
    expect(screen.getByTestId('guide-article').getAttribute('lang')).toBe('en');
  });

  test('the index lists every page in order; an unknown page says it is not in the guide', () => {
    render(<GuideIndex pages={pages} />);
    const links = within(screen.getByTestId('guide-index')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(pages.map((p) => `/help/${p.slug}`));
    render(<GuideNotFound />);
    expect(screen.getByRole('heading', { name: 'This page isn’t in the guide' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the guide' }).getAttribute('href')).toBe(
      '/help',
    );
  });

  test('a failed load offers a retry', () => {
    const onRetry = vi.fn();
    render(<GuideStatus error={new Error('offline')} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the guide');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  test('the guide loads per locale, once', async () => {
    const first = loadGuide('sv');
    expect(loadGuide('sv')).toBe(first);
    expect((await first)[0]?.title).toBe('Kom igång');
    const { result, rerender } = renderHook(({ locale }) => useGuide(locale), {
      initialProps: { locale: 'en' as 'en' | 'sv' },
    });
    await waitFor(() => expect(result.current.pages?.[0]?.title).toBe('Getting started'));
    rerender({ locale: 'sv' });
    await waitFor(() => expect(result.current.pages?.[0]?.title).toBe('Kom igång'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.pages).toBeDefined());
  });

  test('neighbours at the ends and for an unknown slug', () => {
    expect(neighbours(pages, 'getting-started').previous).toBeUndefined();
    expect(neighbours(pages, 'settings-and-data').next).toBeUndefined();
    expect(neighbours(pages, 'nope')).toEqual({ previous: undefined, next: undefined });
  });
});
