import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  errorCode,
  useAcceptInvite,
  useAuthProviders,
  useInvitePreview,
  useMe,
  useSignInWithInvite,
} from '../data';
import { InvitePage } from '../features/auth/invite-page';
import { orgUrlSlug, paths } from '../features/shell/paths';
import { toast } from '../ui/toast';

export const Route = createFileRoute('/invite/$token')({
  component: InviteRoute,
});

function InviteRoute() {
  const { t } = useTranslation('auth');
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const preview = useInvitePreview(token);
  const me = useMe();
  const providers = useAuthProviders();
  const accept = useAcceptInvite();
  const signInWithInvite = useSignInWithInvite();

  // Back from signing in through this invite (or a member re-opening it): the server
  // already added the membership, so continue to the org.
  const orgSlug = preview.data?.org?.slug;
  const joined = orgSlug ? me.data?.orgs.find((o) => o.slug === orgSlug) : undefined;
  const forwarded = useRef(false);
  useEffect(() => {
    if (!joined || forwarded.current) return;
    forwarded.current = true;
    toast({ message: t('invite.joined', { org: joined.name }) });
    void navigate({ href: paths.orgView(orgUrlSlug(joined), 'my'), replace: true });
  }, [joined, navigate, t]);

  if (!preview.data || (me.isPending && !me.error) || joined) return null;
  return (
    <InvitePage
      preview={preview.data}
      signedIn={Boolean(me.data)}
      providers={providers.data ?? []}
      isPending={accept.isPending || signInWithInvite.isPending}
      homeHref={paths.home}
      onAcceptAndSignIn={async (providerId) => {
        try {
          await signInWithInvite.mutateAsync({ token, providerId });
        } catch {
          toast({ message: t('invite.failed'), tone: 'danger' });
        }
      }}
      onJoin={async () => {
        try {
          const org = await accept.mutateAsync({ token });
          toast({ message: t('invite.joined', { org: org.name }) });
          await navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
        } catch (error) {
          toast({
            message:
              errorCode(error) === 'invite_email_mismatch'
                ? t('invite.emailMismatch')
                : t('invite.failed'),
            tone: 'danger',
          });
        }
      }}
    />
  );
}
