import type { DeviceApprove, DeviceRequest } from '@rooster/core/schemas';
import { AppWindow, CircleCheck, CircleX, Globe, SquareTerminal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type DisplayPrefs, formatTimeAgo } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { TextField } from '../../ui/input';
import { cleanClientText, clientName, displayDomain } from './client-display';
import { ConsentActions, ConsentFrame, UnverifiedBadge } from './consent-frame';
import { ConstraintEditor } from './constraint-editor';
import {
  deviceCeiling,
  deviceNewScopes,
  deviceRetainedScopes,
  deviceStart,
  formatUserCode,
  type GrantIssue,
  type GrantOrgOption,
  type GrantValue,
  grantIssues,
  normalizeUserCode,
  reconcileGrant,
  toDeviceApprove,
} from './grant-model';

export type DeviceError = 'notFound' | 'expired' | 'used' | 'tooMany' | 'failed';

export type DevicePageState =
  | {
      kind: 'enter';
      code?: string | undefined;
      error?: DeviceError | undefined;
      /**
       * The code came with the link (`?user_code=`), not from the user's hands: it is shown
       * for the user to compare and confirm, never looked up on its own (11 §9.3, RFC 10027).
       */
      prefilled?: boolean | undefined;
    }
  | { kind: 'loading'; code: string }
  | { kind: 'request'; request: DeviceRequest }
  | {
      kind: 'approved' | 'denied';
      clientName: string;
      /** A third-party app rather than rooster's CLI: "go back to your device". */
      app?: boolean | undefined;
    };

export interface DevicePageProps {
  state: DevicePageState;
  /** Who is signed in, so the user approves for the right account. */
  account: string;
  /** Instance admin: may grant the `admin` capability when the CLI asks for it. */
  isAdmin?: boolean | undefined;
  orgs: readonly GrantOrgOption[];
  prefs: DisplayPrefs;
  now: number;
  onSubmitCode: (code: string) => void;
  onApprove: (input: DeviceApprove) => Promise<void>;
  onDeny: () => Promise<void>;
  homeHref: string;
  /**
   * The server-confirmed orgs and groups, fetched afresh right before Allow: what is gone is
   * dropped from the approval (as on the consent screen). Without it nothing is pruned.
   */
  confirmOrgs?: (() => Promise<readonly GrantOrgOption[]>) | undefined;
  /** Kitchen sink: no full-viewport frame, no focus moves. */
  embedded?: boolean | undefined;
  /** Kitchen sink: start the editor from this value. */
  initialValue?: GrantValue | undefined;
}

/**
 * `/device` (07 §2, 11 §9.3, ADR 0065): approve a device-grant request, rooster's CLI or an app,
 * from any signed-in browser, often a phone (AC-8.1, AC-12.1). The user types the code, then
 * sees the request in full context (who, for which account, the code to compare, where and
 * when it started, the warning) and chooses what it may do, where and for how long.
 */
export function DevicePage(props: DevicePageProps) {
  const { state, embedded } = props;
  return (
    <ConsentFrame embedded={embedded}>
      {state.kind === 'enter' || state.kind === 'loading' ? (
        <CodeStep {...props} state={state} />
      ) : state.kind === 'request' ? (
        <RequestStep {...props} request={state.request} />
      ) : (
        <DoneStep {...props} state={state} />
      )}
    </ConsentFrame>
  );
}

function CodeStep({
  state,
  onSubmitCode,
  embedded,
}: DevicePageProps & { state: Extract<DevicePageState, { kind: 'enter' | 'loading' }> }) {
  const { t } = useTranslation('auth');
  const [code, setCode] = useState(state.code ? formatUserCode(state.code) : '');
  const clean = normalizeUserCode(code);
  const error = state.kind === 'enter' ? state.error : undefined;
  const prefilled = state.kind === 'enter' && state.prefilled === true && !error;
  return (
    <form
      className="flex flex-col gap-6 pb-6 tablet:pb-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (clean.length > 0) onSubmitCode(clean);
      }}
      data-testid="device-code-form"
    >
      <div className="flex flex-col gap-2">
        <h1 className="text-xl">{t('device.enter.title')}</h1>
        <p className="text-sm text-text-secondary">{t('device.enter.body')}</p>
      </div>
      {error && (
        <Banner tone="danger" role="alert" title={t(`device.error.${error}.title`)}>
          {t(`device.error.${error}.body`)}
        </Banner>
      )}
      <TextField
        label={t('device.enter.label')}
        placeholder={t('device.enter.placeholder')}
        value={code}
        onChange={setCode}
        autoFocus={!embedded}
        autoComplete="one-time-code"
        spellCheck="false"
        maxLength={20}
        inputClassName="font-mono uppercase tracking-wide"
        {...(prefilled ? { description: t('device.enter.prefilled') } : {})}
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        isLoading={state.kind === 'loading'}
        isDisabled={clean.length === 0}
      >
        {t('device.enter.continue')}
      </Button>
    </form>
  );
}

/**
 * Who is asking. rooster's own CLI is named by rooster; a third-party app's name is what it
 * says about itself (cleaned), so it is always "Unverified" with the host of its client id and
 * never shows a logo (11 §9.1: nothing binds the client id to the device in this flow).
 */
function DeviceClient({ request, account }: { request: DeviceRequest; account: string }) {
  const { t } = useTranslation('auth');
  const app = !request.firstParty;
  const name = deviceClientName(request, t('device.request.cli'));
  const Icon = app ? AppWindow : SquareTerminal;
  return (
    <div className="flex items-start gap-3">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-bg-muted text-text-secondary">
        <Icon className="size-5" strokeWidth={iconStrokeWidth} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="min-w-0 text-base font-medium break-words text-text"
            data-testid="device-client-name"
          >
            {name}
          </span>
          {app && (
            <>
              <UnverifiedBadge
                label={t('device.request.unverified')}
                data-testid="device-unverified"
              />
              {request.client && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Globe
                    className="size-4 shrink-0 text-text-muted"
                    strokeWidth={iconStrokeWidth}
                    aria-hidden
                  />
                  <span className="sr-only">{t('device.request.domain')}</span>
                  <span
                    className="min-w-0 font-mono text-sm break-all text-text"
                    data-testid="device-client-domain"
                  >
                    {displayDomain(request.client.domain)}
                  </span>
                </span>
              )}
            </>
          )}
        </span>
        <span className="text-sm text-text-secondary">
          {t('device.request.wants')}{' '}
          <span className="font-medium break-words text-text" data-testid="device-account">
            {account}
          </span>
        </span>
        {app && (
          <span className="text-sm text-text-muted">{t('device.request.unverifiedHint')}</span>
        )}
      </div>
    </div>
  );
}

/** The context to check against the device (RFC 10027 §6.1.14): the code, where, when. */
function DeviceContext({
  request,
  prefs,
  now,
}: {
  request: DeviceRequest;
  prefs: DisplayPrefs;
  now: number;
}) {
  const { t } = useTranslation('auth');
  const ip = request.requestIp ? cleanClientText(request.requestIp, 64) : '';
  const ago =
    request.requestedAt > 0
      ? formatTimeAgo(request.requestedAt, now, prefs.locale, t('device.request.justNow'))
      : null;
  const from = ago
    ? ip
      ? t('device.request.startedFrom', { ip, ago })
      : t('device.request.started', { ago })
    : ip;
  return (
    <dl className="flex flex-col gap-2 rounded-md bg-bg-subtle px-3 py-2 text-sm">
      <div className="flex flex-col gap-0.5">
        <dt className="text-text-secondary">{t('device.request.code')}</dt>
        <dd className="flex flex-col gap-0.5">
          <span
            className="font-mono text-lg tracking-wide text-text"
            data-testid="device-user-code"
          >
            {formatUserCode(request.userCode)}
          </span>
          <span className="text-text-secondary">{t('device.request.checkCode')}</span>
        </dd>
      </div>
      {from && (
        <div className="flex flex-col gap-0.5">
          <dt className="text-text-secondary">{t('device.request.from')}</dt>
          <dd className="text-text" data-testid="device-origin">
            {from}
          </dd>
        </div>
      )}
      {request.resource && (
        <div className="flex flex-col gap-0.5">
          <dt className="text-text-secondary">{t('device.request.resource')}</dt>
          <dd className="text-text" data-testid="device-resource">
            {t(`consent.resourceKind.${request.resource}`)}
          </dd>
        </div>
      )}
    </dl>
  );
}

function RequestStep({
  request,
  account,
  isAdmin,
  orgs,
  prefs,
  now,
  onApprove,
  onDeny,
  confirmOrgs,
  initialValue,
  embedded,
}: DevicePageProps & { request: DeviceRequest }) {
  const { t } = useTranslation('auth');
  const { t: ts } = useTranslation('settings');
  const app = !request.firstParty;
  // `admin` only for rooster's CLI and instance admins (ADR 0042 §1, 11 §9.3).
  const offerAdmin = isAdmin === true && !app;
  const [start] = useState(() =>
    initialValue
      ? { value: initialValue, stale: { orgs: 0, groups: 0 } }
      : deviceStart(request, orgs, { isAdmin: offerAdmin }),
  );
  const [value, setValue] = useState<GrantValue>(start.value);
  const [saveIssue, setSaveIssue] = useState<GrantIssue | null>(null);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const blocked = grantIssues(value).length > 0;
  const newScopes = deviceNewScopes(request);
  const stepUp = app && request.existing !== null && newScopes.length > 0;
  const fixedScopes = app && request.existing ? deviceRetainedScopes(request) : undefined;
  const name = deviceClientName(request, t('device.request.cli'));

  // Focus starts on the title, not on a control: nothing is chosen by pressing Enter early,
  // and a screen reader begins with what this page is for.
  useEffect(() => {
    if (!embedded) titleRef.current?.focus();
  }, [embedded]);

  const run = async (which: 'approve' | 'deny', action: () => Promise<void>) => {
    setPending(which);
    try {
      await action();
    } finally {
      setPending(null);
    }
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || pending) return;
        void run('approve', async () => {
          setSaveIssue(null);
          // Confirm afresh right before sending: a group deleted meanwhile would fail it. A
          // failed confirmation prunes nothing; the server has the last word.
          const fresh = confirmOrgs ? await confirmOrgs().catch(() => []) : [];
          const toSend = reconcileGrant(value, fresh).value;
          const [issue] = grantIssues(toSend);
          if (issue) {
            setValue(toSend);
            setSaveIssue(issue);
            return;
          }
          await onApprove(toDeviceApprove(toSend, request));
        });
      }}
      aria-labelledby={titleId}
      data-testid="device-request"
      data-client-kind={app ? 'app' : 'cli'}
    >
      <div className="flex flex-col gap-4">
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="text-xl outline-none"
          data-testid="device-title"
        >
          {t('device.request.title')}
        </h1>
        <DeviceClient request={request} account={account} />
        <DeviceContext request={request} prefs={prefs} now={now} />
        <Banner tone="warning">
          <span data-testid="device-warning">{t('device.request.warning')}</span>
        </Banner>
        {stepUp && <Banner>{t('device.request.stepUp', { client: name })}</Banner>}
        {(start.stale.orgs > 0 || start.stale.groups > 0) && (
          <Banner tone="warning" role="status">
            {[
              start.stale.groups > 0
                ? ts('access.apps.staleGroups', { count: start.stale.groups })
                : null,
              start.stale.orgs > 0
                ? ts('access.apps.staleOrgs', { count: start.stale.orgs })
                : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </Banner>
        )}
      </div>
      <ConstraintEditor
        value={value}
        onChange={setValue}
        orgs={orgs}
        ceiling={deviceCeiling(request, { isAdmin: offerAdmin })}
        // "New" only means something next to an existing grant (step-up).
        newScopes={stepUp ? newScopes : undefined}
        offerAdmin={offerAdmin}
        offerSessionOnly={request.offerSessionOnly}
        deleteCheckbox
        fixedScopes={fixedScopes}
        prefs={prefs}
        now={now}
        data-testid="device-editor"
      />
      {saveIssue && (
        <p role="alert" className="text-sm text-text-danger" data-testid="device-issue">
          {saveIssue.kind === 'noScopes'
            ? ts('access.issue.noScopes')
            : saveIssue.kind === 'noOrgs'
              ? ts('access.issue.noOrgs')
              : ts('access.issue.noGroups')}
        </p>
      )}
      <ConsentActions
        approveLabel={t('device.request.approve')}
        denyLabel={t('device.request.deny')}
        pending={pending}
        blocked={blocked}
        onDeny={() => void run('deny', onDeny)}
        data-testid="device"
      />
    </form>
  );
}

function DoneStep({
  state,
  homeHref,
}: DevicePageProps & { state: Extract<DevicePageState, { kind: 'approved' | 'denied' }> }) {
  const { t } = useTranslation('auth');
  const approved = state.kind === 'approved';
  const Icon = approved ? CircleCheck : CircleX;
  const name = cleanClientText(state.clientName);
  return (
    <div className="flex flex-col gap-6 pb-6 tablet:pb-8" role="status" data-testid="device-done">
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon
          className={cn('size-10', approved ? 'text-text-success' : 'text-text-secondary')}
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <h1 className="text-xl break-words">
          {approved
            ? t('device.done.approvedTitle', { client: name })
            : t('device.done.deniedTitle')}
        </h1>
        <p className="text-sm text-text-secondary">
          {approved
            ? t(state.app ? 'device.done.approvedBodyApp' : 'device.done.approvedBody')
            : t(state.app ? 'device.done.deniedBodyApp' : 'device.done.deniedBody')}
        </p>
      </div>
      <Link href={homeHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('device.done.home')}
      </Link>
    </div>
  );
}

/** "rooster CLI" for rooster's own CLI; else the app's cleaned self-description. */
export function deviceClientName(
  request: Pick<DeviceRequest, 'firstParty' | 'client' | 'clientName'>,
  cliName: string,
): string {
  if (request.firstParty) return cliName;
  if (request.client) return clientName(request.client);
  return cleanClientText(request.clientName);
}
