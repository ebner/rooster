import { isLocale } from '@rooster/i18n/core';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, meQueryOptions, useDisplayPrefs, useMe } from '../data';
import {
  deviceErrorKind,
  deviceKeys,
  useApproveDevice,
  useDenyDevice,
  useDeviceRequest,
} from '../data/device';
import { confirmGrantOrgs, useGrantOrgsState } from '../data/grants';
import { DevicePage, type DevicePageState, deviceClientName } from '../features/access/device-page';
import { setLocale } from '../lib/i18n';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface DeviceSearch {
  user_code?: string;
}

/**
 * `/device` (07 §2, 11 §9.3, AC-8.1, AC-12.1): the device grant's verification URI, for the CLI
 * and for apps. Signed in, outside the app frame: a focused consent page that works the same on
 * a phone. Signed out → `/login` and back.
 *
 * The user always types the code (11 §9.2, ADR 0065): a code in the link (`?user_code=`, which
 * older CLIs still open) is never used, not even to pre-fill the field, since a pre-filled code
 * is the device-code phishing vector (RFC 10027). The page only says that links don't carry
 * codes.
 */
export const Route = createFileRoute('/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch =>
    // Only whether a code came with the link, never the code itself.
    search.user_code !== undefined && search.user_code !== '' ? { user_code: 'link' } : {},
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({ ...meQueryOptions, revalidateIfStale: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const target = safeRedirectPath(location.href);
        throw redirect({ to: '/login', search: target ? { redirect: target } : {} });
      }
      throw error;
    }
  },
  component: DeviceRoute,
});

type Outcome = { kind: 'approved' | 'denied'; clientName: string; app: boolean };

function DeviceRoute() {
  const { t, i18n } = useTranslation('auth');
  const { user_code: linkCode } = Route.useSearch();
  const queryClient = useQueryClient();
  const me = useMe();
  const prefs = useDisplayPrefs();
  const { orgs, ready } = useGrantOrgsState();
  // The code the user confirmed with Continue: the only one ever looked up.
  const [userCode, setUserCode] = useState<string | undefined>(undefined);
  const request = useDeviceRequest(userCode);
  const approve = useApproveDevice();
  const deny = useDenyDevice();
  // Outside the app frame, so follow the profile's language here too (04 §8).
  const storedLocale = me.data?.user.locale;
  useEffect(() => {
    if (isLocale(storedLocale) && storedLocale !== i18n.language) void setLocale(storedLocale);
  }, [storedLocale, i18n.language]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // An approve or deny that found the code expired or used: back to the code step, explained.
  const [lateError, setLateError] = useState<ReturnType<typeof deviceErrorKind> | null>(null);

  const state: DevicePageState = outcome
    ? outcome
    : !userCode
      ? { kind: 'enter', codeInLink: Boolean(linkCode) }
      : lateError
        ? { kind: 'enter', code: userCode, error: lateError }
        : request.error
          ? { kind: 'enter', code: userCode, error: deviceErrorKind(request.error) }
          : request.data && ready
            ? { kind: 'request', request: request.data }
            : { kind: 'loading', code: userCode };

  const settle = (error: unknown, fallback: string) => {
    const kind = deviceErrorKind(error);
    if (kind === 'failed') toast({ message: fallback, tone: 'danger' });
    else setLateError(kind);
  };
  const finish = (kind: Outcome['kind']) => {
    if (!request.data) return;
    setOutcome({
      kind,
      clientName: deviceClientName(request.data, t('device.request.cli')),
      app: !request.data.firstParty,
    });
  };

  return (
    <DevicePage
      // A new code starts the code step afresh (its field is seeded from the code).
      key={`${state.kind}:${userCode ?? ''}`}
      state={state}
      account={me.data?.user.email ?? ''}
      isAdmin={me.data?.user.isAdmin === true}
      orgs={orgs}
      prefs={prefs}
      now={Date.now()}
      homeHref="/"
      confirmOrgs={() => confirmGrantOrgs(orgs.map((org) => org.id))}
      onSubmitCode={(code) => {
        setLateError(null);
        // The same code again (after a hiccup or an error): ask once more.
        if (code === userCode)
          void queryClient.resetQueries({ queryKey: deviceKeys.request(code) });
        setUserCode(code);
      }}
      onApprove={async (body) => {
        if (!userCode || !request.data) return;
        try {
          await approve.mutateAsync({ userCode, body });
          finish('approved');
        } catch (error) {
          settle(error, t('device.approveFailed'));
        }
      }}
      onDeny={async () => {
        if (!userCode || !request.data) return;
        try {
          await deny.mutateAsync({ userCode, decisionNonce: request.data.decisionNonce });
          finish('denied');
        } catch (error) {
          settle(error, t('device.denyFailed'));
        }
      }}
    />
  );
}
