import type { OAuthConsentDecision, OAuthConsentRequest } from '@rooster/core/schemas';
import {
  AppWindow,
  BadgeCheck,
  CircleCheck,
  CircleX,
  Globe,
  Laptop,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { DisplayPrefs } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { Skeleton } from '../../ui/skeleton';
import {
  clientName,
  displayDomain,
  displayRedirect,
  httpsLogo,
  isVerifiedClient,
  resourceKind,
} from './client-display';
import { ConsentActions, ConsentFrame } from './consent-frame';
import { ConstraintEditor } from './constraint-editor';
import {
  consentCeiling,
  consentStart,
  type GrantIssue,
  type GrantOrgOption,
  type GrantValue,
  grantIssues,
  reconcileGrant,
  retainedScopes,
  toConsentDecision,
} from './grant-model';

export type ConsentPageState =
  /** The request, or the orgs and groups the defaults need, are still loading. */
  | { kind: 'loading' }
  /** No signed query, or the server refused it: expired, tampered or already answered. */
  | { kind: 'invalid' }
  /** The request couldn't be loaded (network, server error): worth another try. */
  | { kind: 'failed' }
  | { kind: 'request'; request: OAuthConsentRequest }
  /** Decided; the browser is on its way back to the client. */
  | { kind: 'leaving'; accepted: boolean; clientName: string };

export interface ConsentPageProps {
  state: ConsentPageState;
  /** Who is signed in, so the user consents for the right account. */
  account: string;
  orgs: readonly GrantOrgOption[];
  prefs: DisplayPrefs;
  now: number;
  onAllow: (decision: OAuthConsentDecision) => Promise<void>;
  onDeny: () => Promise<void>;
  homeHref: string;
  /** Loads the request again (the `failed` state). */
  onRetry?: (() => void) | undefined;
  /**
   * The server-confirmed orgs and groups, fetched afresh right before Allow: what is gone is
   * dropped from the decision (as in Connected apps). Without it nothing is pruned on send.
   */
  confirmOrgs?: (() => Promise<readonly GrantOrgOption[]>) | undefined;
  /** The server refused the decision as approving nothing the app asked for (`422`). */
  notice?: 'nothingApproved' | null | undefined;
  /** Kitchen sink: no full-viewport frame, no focus moves. */
  embedded?: boolean | undefined;
  /** Kitchen sink: start the editor from this value. */
  initialValue?: GrantValue | undefined;
}

/**
 * `/oauth/consent` (11 §3.1, ADR 0041): an app (a remote MCP client, a third-party app) asks
 * for access through rooster's OAuth server. Who is asking (name, domain, verified or not, and
 * where the browser goes back to), what it may do, where, and for how long; Allow or Deny.
 */
export function ConsentPage(props: ConsentPageProps) {
  const { state, embedded } = props;
  return (
    <ConsentFrame embedded={embedded}>
      {state.kind === 'loading' ? (
        <LoadingStep />
      ) : state.kind === 'invalid' ? (
        <InvalidStep homeHref={props.homeHref} />
      ) : state.kind === 'failed' ? (
        <FailedStep onRetry={props.onRetry} />
      ) : state.kind === 'request' ? (
        <RequestStep {...props} request={state.request} />
      ) : (
        <LeavingStep state={state} />
      )}
    </ConsentFrame>
  );
}

function LoadingStep() {
  const { t } = useTranslation('auth');
  return (
    <div className="flex flex-col gap-4 pb-6 tablet:pb-8" aria-busy="true">
      <span className="sr-only" role="status">
        {t('consent.loading')}
      </span>
      <Skeleton className="size-10 rounded-md" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function InvalidStep({ homeHref }: { homeHref: string }) {
  const { t } = useTranslation('auth');
  return (
    <div className="flex flex-col gap-6 pb-6 tablet:pb-8" data-testid="consent-invalid">
      <Banner tone="danger" role="alert" title={t('consent.invalid.title')}>
        {t('consent.invalid.body')}
      </Banner>
      <Link href={homeHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('consent.home')}
      </Link>
    </div>
  );
}

function FailedStep({ onRetry }: { onRetry: (() => void) | undefined }) {
  const { t } = useTranslation('auth');
  return (
    <div className="flex flex-col gap-6 pb-6 tablet:pb-8" data-testid="consent-failed">
      <Banner tone="danger" role="alert" title={t('consent.failed.title')}>
        {t('consent.failed.body')}
      </Banner>
      {onRetry && (
        <Button size="lg" onPress={onRetry}>
          {t('consent.failed.retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * The client as it presents itself. Its name is client-supplied, so it never stands alone: the
 * domain sits right under it, with "Verified" or "Unverified app", and the name only appears
 * inside rooster's own sentences (never as rooster UI).
 */
function ClientIdentity({ request }: { request: OAuthConsentRequest }) {
  const { t } = useTranslation('auth');
  const { client } = request;
  const logo = httpsLogo(client.logoUri);
  const [logoFailed, setLogoFailed] = useState(false);
  const verified = isVerifiedClient(client);
  const FallbackIcon = request.loopback ? Laptop : AppWindow;
  return (
    <div className="flex items-start gap-3">
      {logo && !logoFailed ? (
        <img
          src={logo}
          alt=""
          className="size-10 shrink-0 rounded-md border border-border bg-bg-app object-contain"
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
          data-testid="consent-logo"
        />
      ) : (
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-bg-muted text-text-secondary">
          <FallbackIcon className="size-5" strokeWidth={iconStrokeWidth} aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Globe
            className="size-4 shrink-0 text-text-muted"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
          <span className="sr-only">{t('consent.domain')}</span>
          <span
            className="min-w-0 font-mono text-base font-medium break-all text-text"
            data-testid="consent-domain"
          >
            {displayDomain(client.domain)}
          </span>
          {verified ? (
            <span
              className="inline-flex h-chip items-center gap-0.5 rounded-xs bg-bg-success-subtle px-1.5 text-xs font-medium text-text-success"
              data-testid="consent-verified"
            >
              <BadgeCheck className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
              {t('consent.verified')}
            </span>
          ) : (
            <span
              className="inline-flex h-chip items-center gap-0.5 rounded-xs bg-bg-warning-subtle px-1.5 text-xs font-medium text-text-warning"
              data-testid="consent-unverified"
            >
              <ShieldAlert className="size-3" strokeWidth={iconStrokeWidth} aria-hidden />
              {t('consent.unverified')}
            </span>
          )}
        </span>
        <span className="text-sm text-text-secondary">
          {verified ? t('consent.verifiedHint') : t('consent.unverifiedHint')}
        </span>
      </div>
    </div>
  );
}

function RequestDetails({ request }: { request: OAuthConsentRequest }) {
  const { t } = useTranslation('auth');
  const kind = resourceKind(request.resource);
  return (
    <dl className="flex flex-col gap-2 rounded-md bg-bg-subtle px-3 py-2 text-sm">
      <div className="flex flex-col gap-0.5">
        <dt className="text-text-secondary">{t('consent.returnsTo')}</dt>
        <dd className="min-w-0 text-text" data-testid="consent-redirect">
          {request.loopback ? (
            <>
              <span className="font-medium">{t('consent.loopback')}</span>{' '}
              <span className="font-mono text-xs break-all text-text-muted">
                ({displayRedirect(request.redirectUri)})
              </span>
            </>
          ) : (
            <span className="font-mono text-xs break-all">
              {displayRedirect(request.redirectUri)}
            </span>
          )}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-text-secondary">{t('consent.resource')}</dt>
        <dd className="text-text">
          {kind === 'other' ? (
            <span className="font-mono text-xs break-all">{displayRedirect(request.resource)}</span>
          ) : (
            t(`consent.resourceKind.${kind}`)
          )}
        </dd>
      </div>
    </dl>
  );
}

function RequestStep({
  request,
  account,
  orgs,
  prefs,
  now,
  onAllow,
  onDeny,
  initialValue,
  embedded,
  confirmOrgs,
  notice,
}: ConsentPageProps & { request: OAuthConsentRequest }) {
  const { t } = useTranslation('auth');
  const { t: ts } = useTranslation('settings');
  // On step-up the grant may name groups deleted (or orgs left) since: dropped up front, and
  // said so, since the server would refuse them.
  const [start] = useState(() =>
    initialValue
      ? { value: initialValue, stale: { orgs: 0, groups: 0 } }
      : consentStart(request, orgs),
  );
  const [value, setValue] = useState<GrantValue>(start.value);
  const [saveIssue, setSaveIssue] = useState<GrantIssue | null>(null);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const fixedScopes = retainedScopes(request);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const name = clientName(request.client);
  const blocked = grantIssues(value).length > 0;
  const stepUp = request.existing !== null && request.newScopes.length > 0;

  // Focus starts on the title, not on a control: nothing is chosen by pressing Enter early,
  // and a screen reader begins with who is asking.
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
          await onAllow(toConsentDecision(toSend, request.oauthQuery));
        });
      }}
      aria-labelledby={titleId}
      data-testid="consent-request"
    >
      <div className="flex flex-col gap-4">
        <ClientIdentity request={request} />
        <div className="flex flex-col gap-2">
          <h1
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="text-xl break-words outline-none"
            data-testid="consent-title"
          >
            {t('consent.title', { client: name })}
          </h1>
          <p className="text-sm text-text-secondary">
            {t('consent.body', { client: name, account })}
          </p>
        </div>
        {!isVerifiedClient(request.client) && (
          <Banner tone="warning" title={t('consent.unverifiedTitle')}>
            {request.client.dynamic ? t('consent.dynamicBody') : t('consent.unverifiedBody')}
          </Banner>
        )}
        {stepUp && <Banner>{t('consent.stepUp', { client: name })}</Banner>}
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
        <RequestDetails request={request} />
      </div>
      <ConstraintEditor
        value={value}
        onChange={setValue}
        orgs={orgs}
        ceiling={consentCeiling(request)}
        // "New" only means something next to an existing grant (step-up).
        newScopes={stepUp ? request.newScopes : undefined}
        offerSessionOnly
        deleteCheckbox
        fixedScopes={request.existing ? fixedScopes : undefined}
        prefs={prefs}
        now={now}
        data-testid="consent-editor"
      />
      {(saveIssue || notice) && (
        <p role="alert" className="text-sm text-text-danger" data-testid="consent-issue">
          {notice === 'nothingApproved'
            ? t('consent.nothingApproved')
            : saveIssue?.kind === 'noScopes'
              ? ts('access.issue.noScopes')
              : saveIssue?.kind === 'noOrgs'
                ? ts('access.issue.noOrgs')
                : ts('access.issue.noGroups')}
        </p>
      )}
      <ConsentActions
        approveLabel={t('consent.allow')}
        denyLabel={t('consent.deny')}
        pending={pending}
        blocked={blocked}
        onDeny={() => void run('deny', onDeny)}
        data-testid="consent"
      />
    </form>
  );
}

function LeavingStep({ state }: { state: Extract<ConsentPageState, { kind: 'leaving' }> }) {
  const { t } = useTranslation('auth');
  const Icon = state.accepted ? CircleCheck : CircleX;
  const name = cleanName(state.clientName);
  return (
    <div className="flex flex-col gap-6 pb-6 tablet:pb-8" role="status" data-testid="consent-done">
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon
          className={cn('size-10', state.accepted ? 'text-text-success' : 'text-text-secondary')}
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <h1 className="text-xl break-words">
          {state.accepted
            ? t('consent.done.allowedTitle', { client: name })
            : t('consent.done.deniedTitle')}
        </h1>
        <p className="text-sm text-text-secondary">{t('consent.done.leaving', { client: name })}</p>
      </div>
    </div>
  );
}

function cleanName(name: string): string {
  return clientName({ name, domain: '' });
}
