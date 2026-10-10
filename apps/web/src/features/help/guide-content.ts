import type { Locale } from '@rooster/i18n/core';
import { useCallback, useEffect, useState } from 'react';
import type { GuidePage } from './guide-model';

export type { GuidePage } from './guide-model';

/** One lazy chunk per locale; it ships with the app's JS, so the guide works offline. */
const loaders: Record<Locale, () => Promise<{ pages: GuidePage[] }>> = {
  en: () => import('virtual:rooster-guide/en'),
  sv: () => import('virtual:rooster-guide/sv'),
};

const cache = new Map<Locale, Promise<GuidePage[]>>();

export function loadGuide(locale: Locale): Promise<GuidePage[]> {
  let pending = cache.get(locale);
  if (!pending) {
    pending = loaders[locale]().then(
      (module) => module.pages,
      (error: unknown) => {
        // A failed chunk (offline before it was cached) can be retried.
        cache.delete(locale);
        throw error;
      },
    );
    cache.set(locale, pending);
  }
  return pending;
}

export interface GuideState {
  pages: GuidePage[] | undefined;
  error: unknown;
  retry: () => void;
}

/** The guide in `locale`; `pages` is undefined while its chunk loads. */
export function useGuide(locale: Locale): GuideState {
  const [state, setState] = useState<{ locale: Locale; pages?: GuidePage[]; error?: unknown }>({
    locale,
  });
  const [attempt, setAttempt] = useState(0);
  // `attempt` re-runs the load on retry.
  useEffect(() => {
    let live = true;
    loadGuide(locale).then(
      (pages) => live && setState({ locale, pages }),
      (error: unknown) => live && setState({ locale, error }),
    );
    return () => {
      live = false;
    };
  }, [locale, attempt]);
  const retry = useCallback(() => {
    setState({ locale });
    setAttempt((n) => n + 1);
  }, [locale]);
  const current = state.locale === locale;
  return {
    pages: current ? state.pages : undefined,
    error: current ? state.error : undefined,
    retry,
  };
}
