import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { inviteCookie } from '../auth/cookies.ts';
import type { Config } from '../config.ts';
import type { AppEnv } from '../lib/context.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, idParam, json, problems } from './common.ts';
import { InvitePreviewSchema, OrgSchema } from './schemas.ts';

const tags = ['invites'];
const tokenParams = z.object({ token: idParam('token', 'The token from the invite URL') });

const previewInvite = createRoute({
  method: 'get',
  path: '/api/v1/invites/{token}',
  tags,
  operationId: 'previewInvite',
  summary: 'Preview an invite (no auth)',
  description:
    'What the `/invite/:token` page shows before sign-in: the org, who invited, the role, and whether the invite can still be used (`valid`, else `reason`). An unknown token is `404`.',
  request: { params: tokenParams },
  responses: { 200: json(InvitePreviewSchema, 'The invite'), ...problems(404) },
});

const claimInvite = createRoute({
  method: 'post',
  path: '/api/v1/invites/{token}/claim',
  tags,
  operationId: 'claimInvite',
  summary: 'Carry an invite through sign-in (no auth)',
  description:
    'Sets the signed, httpOnly `rooster.invite` cookie (15 minutes). Signing in while it is set admits a person who is not otherwise allowlisted, and joins the org (04 §4.4).',
  request: { params: tokenParams },
  responses: {
    200: json(InvitePreviewSchema, 'The invite; the cookie is set'),
    ...problems(404, 415, 'csrf_origin', 'invite_invalid'),
  },
});

const acceptInvite = createRoute({
  method: 'post',
  path: '/api/v1/invites/{token}/accept',
  tags,
  operationId: 'acceptInvite',
  summary: 'Join the org of an invite as the signed-in user',
  description:
    'Creates my membership with the invite’s role, my Inbox and the default groups. Already a member: a no-op that returns the org. An email invite only admits its address (`403 invite_email_mismatch`); a used, expired or revoked invite is `410 invite_invalid`.',
  request: { params: tokenParams },
  responses: {
    200: json(OrgSchema, 'The joined org'),
    ...problems(...AUTHED, 404, 'invite_email_mismatch', 'invite_invalid'),
  },
});

export function registerInviteRoutes(
  app: OpenAPIHono<AppEnv>,
  { orgs }: Services,
  deps: { config: Config; clock: () => number },
): void {
  const secure = deps.config.baseUrl.startsWith('https://');
  app.openapi(previewInvite, (c) => c.json(orgs.previewInvite(c.req.valid('param').token), 200));
  app.openapi(claimInvite, (c) => {
    const { token } = c.req.valid('param');
    const preview = orgs.claimInvite(token);
    c.header('Set-Cookie', inviteCookie(deps.config.authSecret, token, deps.clock(), secure), {
      append: true,
    });
    return c.json(preview, 200);
  });
  app.openapi(acceptInvite, (c) =>
    c.json(orgs.acceptInvite(actorOf(c), c.req.valid('param').token), 200),
  );
}
