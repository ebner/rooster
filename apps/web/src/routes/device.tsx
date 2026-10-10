import { isLocale } from '@rooster/i18n/core';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
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
import { useGrantOrgs } from '../data/grants';
import { DevicePage, type DevicePageState } from '../features/access/device-page';
import { setLocale } from '../lib/i18n';
import { safeRedirectPath } from '../lib/safe-redirect';
import { toast } from '../ui/toast';

interface DeviceSearch {
  user_code?: string;
}

/**
 * `/device` (07 §2, 11 §3.1, AC-8.1): the CLI's verification URI. Signed in, outside the app
 * frame: a focused consent page that works the same on a phone. Signed out → `/login` and back.
 */
export const Route = createFileRoute('/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch => {
    // Like `normalizeUserCode`, inlined: the route options load with the app, the page lazily.
    const code =
      typeof search.user_code === 'string'
        ? search.user_code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
        : '';
    return code ? { user_code: code.slice(0, 32) } : {};
  },
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

type Outcome = { kind: 'approved' | 'denied'; clientName: string };

function DeviceRoute() {
  const { t, i18n } = useTranslation('auth');
  const { user_code: userCode } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const prefs = useDisplayPrefs();
  const orgs = useGrantOrgs();
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
      ? { kind: 'enter' }
      : lateError
        ? { kind: 'enter', code: userCode, error: lateError }
        : request.error
          ? { kind: 'enter', code: userCode, error: deviceErrorKind(request.error) }
          : request.data
            ? { kind: 'request', request: request.data }
            : { kind: 'loading', code: userCode };

  const settle = (error: unknown, fallback: string) => {
    const kind = deviceErrorKind(error);
    if (kind === 'failed') toast({ message: fallback, tone: 'danger' });
    else setLateError(kind);
  };

  return (
    <DevicePage
      // A new code starts the code step afresh (its field is seeded from the URL).
      key={`${state.kind}:${userCode ?? ''}`}
      state={state}
      account={me.data?.user.email ?? ''}
      isAdmin={me.data?.user.isAdmin === true}
      orgs={orgs}
      prefs={prefs}
      now={Date.now()}
      homeHref="/"
      onSubmitCode={(code) => {
        setLateError(null);
        // The same code again (after fixing a typo elsewhere, or a hiccup): ask once more.
        if (code === userCode)
          void queryClient.resetQueries({ queryKey: deviceKeys.request(code) });
        void navigate({ to: '/device', search: { user_code: code }, replace: true });
      }}
      onApprove={async (body) => {
        if (!userCode || !request.data) return;
        try {
          await approve.mutateAsync({ userCode, body });
          setOutcome({ kind: 'approved', clientName: request.data.clientName });
        } catch (error) {
          settle(error, t('device.approveFailed'));
        }
      }}
      onDeny={async () => {
        if (!userCode || !request.data) return;
        try {
          await deny.mutateAsync({ userCode, decisionNonce: request.data.decisionNonce });
          setOutcome({ kind: 'denied', clientName: request.data.clientName });
        } catch (error) {
          settle(error, t('device.denyFailed'));
        }
      }}
    />
  );
}
