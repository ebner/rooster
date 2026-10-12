import type { Locale } from '@rooster/i18n/core';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { buildInfo } from '../../data/sync/build-info';
import { syncEngine } from '../../data/sync/engine';
import { compareVersions } from '../../data/sync/events';
import { userStorageKey } from '../../lib/user-storage';
import { toast } from '../../ui/toast';
import { paths } from '../shell/paths';
import { loadGuide } from './guide-content';
import { versionAnchor, whatsNewSlug } from './guide-model';

/**
 * "What's new" (ADR 0057): the guide page `docs/guide/<locale>/whats-new.md` has a `## X.Y.Z`
 * section per release, and the first load of a newer version offers it once, in a toast.
 */
export const whatsNewToastMs = 12_000;
const seenName = 'whatsNew.seen';

export const whatsNewPath = `${paths.help}/${whatsNewSlug}`;

/** A version's section of the page. */
export function whatsNewHref(version: string): string {
  return `${whatsNewPath}#${versionAnchor(version)}`;
}

/**
 * What a page load does: `notify` once per newer version, `record` silently on a first visit
 * (nothing is new to someone who just arrived) or after a downgrade. No version seen yet on a
 * browser this account used before means an account from before "What's new": it is told.
 */
export function whatsNewStep(
  seen: string | null,
  current: string,
  usedHereBefore: boolean,
): 'none' | 'record' | 'notify' {
  if (seen === null) return usedHereBefore ? 'notify' : 'record';
  const cmp = compareVersions(current, seen);
  if (cmp > 0) return 'notify';
  return cmp < 0 ? 'record' : 'none';
}

function readSeen(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSeen(key: string, version: string): void {
  try {
    globalThis.localStorage?.setItem(key, version);
  } catch {
    // Blocked storage: every load is then a first visit, and nothing is offered.
  }
}

/** Offers this version's "What's new" section once per account and browser. */
export function useWhatsNewNotice(userId: string | undefined, locale: Locale): void {
  const { t } = useTranslation('help');
  const navigate = useNavigate();
  useEffect(() => {
    const version = buildInfo.version;
    if (!userId || version === '0.0.0') return;
    const key = userStorageKey(userId, seenName);
    const step = whatsNewStep(readSeen(key), version, syncEngine()?.startOwner === userId);
    if (step === 'none') return;
    if (step === 'record') {
      writeSeen(key, version);
      return;
    }
    let live = true;
    // Only once the guide has loaded: offline, the offer waits for a later load.
    loadGuide(locale).then(
      (pages) => {
        if (!live) return;
        writeSeen(key, version);
        const page = pages.find((p) => p.slug === whatsNewSlug);
        // A release without a section has nothing to show.
        if (!page?.html.includes(` id="${versionAnchor(version)}"`)) return;
        toast({
          message: t('whatsNew.toast', { version }),
          durationMs: whatsNewToastMs,
          action: {
            label: t('whatsNew.action'),
            onAction: () => void navigate({ href: whatsNewHref(version) }),
          },
        });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [userId, locale, t, navigate]);
}
