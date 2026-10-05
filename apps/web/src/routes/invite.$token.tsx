import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
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

  if (!preview.data) return null;
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
          await navigate({ to: '/' });
        } catch {
          toast({ message: t('invite.failed'), tone: 'danger' });
        }
      }}
      onJoin={async () => {
        try {
          const org = await accept.mutateAsync({ token });
          toast({ message: t('invite.joined', { org: org.name }) });
          await navigate({ href: paths.orgView(orgUrlSlug(org), 'my') });
        } catch {
          toast({ message: t('invite.failed'), tone: 'danger' });
        }
      }}
    />
  );
}
