import type { DeviceApprove, DeviceRequest } from '@rooster/core/schemas';
import { CircleCheck, CircleX, SquareTerminal } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { DisplayPrefs } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, buttonVariants, iconStrokeWidth } from '../../ui/button';
import { TextField } from '../../ui/input';
import { Logo } from '../../ui/logo';
import { ConstraintEditor } from './constraint-editor';
import {
  defaultDeviceValue,
  formatUserCode,
  type GrantOrgOption,
  type GrantValue,
  grantIssues,
  normalizeUserCode,
  toDeviceApprove,
} from './grant-model';

export type DeviceError = 'notFound' | 'expired' | 'used' | 'failed';

export type DevicePageState =
  | { kind: 'enter'; code?: string | undefined; error?: DeviceError | undefined }
  | { kind: 'loading'; code: string }
  | { kind: 'request'; request: DeviceRequest }
  | { kind: 'approved'; clientName: string }
  | { kind: 'denied'; clientName: string };

export interface DevicePageProps {
  state: DevicePageState;
  /** Who is signed in, so the user approves for the right account. */
  account: string;
  orgs: readonly GrantOrgOption[];
  prefs: DisplayPrefs;
  now: number;
  onSubmitCode: (code: string) => void;
  onApprove: (input: DeviceApprove) => Promise<void>;
  onDeny: () => Promise<void>;
  homeHref: string;
  /** Kitchen sink: no full-viewport frame. */
  embedded?: boolean | undefined;
  /** Kitchen sink: start the editor from this value. */
  initialValue?: GrantValue | undefined;
}

/**
 * `/device` (07 §2, 11 §3.1): approve a CLI login from any signed-in browser, often a phone
 * (AC-8.1). Enter or confirm the user code, choose what the CLI may do and where, approve.
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

/** A focused page outside the app frame (like sign-in), with the logo; not a modal. */
export function ConsentFrame({
  children,
  embedded = false,
}: {
  children: ReactNode;
  embedded?: boolean | undefined;
}) {
  return (
    <div
      className={cn('flex flex-col bg-bg-subtle', embedded ? 'rounded-lg' : 'min-h-dvh pt-safe')}
    >
      <main className="flex flex-1 flex-col items-center gap-6 px-3 py-8 tablet:px-6 tablet:py-12">
        <Logo size={32} />
        <div className="flex w-full max-w-pane flex-col gap-6 rounded-lg border border-border bg-bg-elevated px-4 pt-6 shadow-sm tablet:px-8 tablet:pt-8">
          {children}
        </div>
      </main>
    </div>
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

function RequestStep({
  request,
  account,
  orgs,
  prefs,
  now,
  onApprove,
  onDeny,
  initialValue,
}: DevicePageProps & { request: DeviceRequest }) {
  const { t } = useTranslation('auth');
  const [value, setValue] = useState<GrantValue>(
    () => initialValue ?? defaultDeviceValue(request.requestedScopes),
  );
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const titleId = useId();
  const blocked = grantIssues(value).length > 0;
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
        if (!blocked && !pending) void run('approve', () => onApprove(toDeviceApprove(value)));
      }}
      aria-labelledby={titleId}
      data-testid="device-request"
    >
      <div className="flex flex-col gap-4">
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
          <SquareTerminal className="size-5" strokeWidth={iconStrokeWidth} aria-hidden />
        </span>
        <div className="flex flex-col gap-2">
          <h1 id={titleId} className="text-xl">
            {t('device.request.title', { client: request.clientName })}
          </h1>
          <p className="text-sm text-text-secondary">
            {t('device.request.body', { client: request.clientName, account })}
          </p>
        </div>
        <div className="flex flex-col gap-1 rounded-md bg-bg-subtle px-3 py-2">
          <span className="text-sm text-text-secondary">{t('device.request.checkCode')}</span>
          <span className="font-mono text-lg tracking-wide" data-testid="device-user-code">
            {formatUserCode(request.userCode)}
          </span>
        </div>
      </div>
      <ConstraintEditor
        value={value}
        onChange={setValue}
        orgs={orgs}
        ceiling={{ scopes: request.requestedScopes }}
        prefs={prefs}
        now={now}
      />
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-bg-elevated px-4 pt-3 pb-safe tablet:-mx-8 tablet:px-8">
        <div className="flex flex-col-reverse gap-2 pb-3 tablet:flex-row tablet:justify-end tablet:pb-6">
          <Button
            size="lg"
            isLoading={pending === 'deny'}
            isDisabled={pending === 'approve'}
            onPress={() => void run('deny', onDeny)}
            className="w-full tablet:w-auto"
          >
            {t('device.request.deny')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            isLoading={pending === 'approve'}
            isDisabled={blocked || pending === 'deny'}
            className="w-full tablet:w-auto"
            data-testid="device-approve"
          >
            {t('device.request.approve')}
          </Button>
        </div>
      </div>
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
  return (
    <div className="flex flex-col gap-6 pb-6 tablet:pb-8" role="status" data-testid="device-done">
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon
          className={cn('size-10', approved ? 'text-text-success' : 'text-text-secondary')}
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
        <h1 className="text-xl">
          {approved
            ? t('device.done.approvedTitle', { client: state.clientName })
            : t('device.done.deniedTitle')}
        </h1>
        <p className="text-sm text-text-secondary">
          {approved ? t('device.done.approvedBody') : t('device.done.deniedBody')}
        </p>
      </div>
      <Link href={homeHref} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
        {t('device.done.home')}
      </Link>
    </div>
  );
}
