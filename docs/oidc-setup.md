# Sign-in setup (OIDC)

rooster has no passwords. People sign in through Google or any OpenID Connect provider (Keycloak, Authentik, Authelia, Zitadel, Microsoft Entra ID and others). At least one provider must be configured, otherwise the server exits with code 78 and prints what is missing.

Who may sign in is decided by rooster, not by the provider:

- `ROOSTER_ADMIN_EMAILS` (required) are always allowed and are instance admins.
- `ROOSTER_ALLOWED_EMAILS` and `ROOSTER_ALLOWED_DOMAINS` add more people, as does the allowlist in Admin → Sign-in.
- Anyone with a valid org invite may sign in.
- The provider must report `email_verified: true`. Unverified emails are rejected.

The redirect (callback) URI always has the form:

```
${ROOSTER_BASE_URL}/api/auth/callback/<provider id>
```

`ROOSTER_BASE_URL` must be the exact public URL people use (scheme, host and port, no trailing slash). It is also used for cookies and the CSRF origin check, so a mismatch shows up as failed sign-ins.

## Google

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create (or pick) a project.
2. **OAuth consent screen:**
   - Google Workspace: choose **Internal**, which limits sign-in to your domain.
   - A personal account: choose **External**, and add yourself and your users as **test users** (or publish the app).
   - The required scopes are `openid`, `email` and `profile`.
3. **Credentials → Create credentials → OAuth client ID**, application type **Web application**.
   - Authorised redirect URI: `https://rooster.example.com/api/auth/callback/google`
4. Set the client ID and secret:

```env
ROOSTER_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
ROOSTER_GOOGLE_CLIENT_SECRET=GOCSPX-…
```

## Generic OIDC provider

`ROOSTER_OIDC_PROVIDERS` is a JSON array. Each entry needs:

| Field | Meaning |
|---|---|
| `id` | Lowercase, unique, and part of the callback URL. `google` is reserved. |
| `name` | The button label on the sign-in page ("Company SSO"). |
| `discoveryUrl` | The provider's `/.well-known/openid-configuration` URL. |
| `clientId`, `clientSecret` | From the provider (a confidential client). |
| `scopes` | Optional. Default `["openid","email","profile"]`. |

PKCE is always used, and ID tokens are verified. The discovery document is fetched at boot, so the provider must be reachable when rooster starts.

```env
ROOSTER_OIDC_PROVIDERS=[{"id":"authentik","name":"Company SSO","discoveryUrl":"https://sso.example.com/application/o/rooster/.well-known/openid-configuration","clientId":"…","clientSecret":"…"}]
```

To keep the secret out of the environment, write the JSON to a file and set `ROOSTER_OIDC_PROVIDERS_FILE=/run/secrets/rooster_oidc` (every variable accepts a `_FILE` form).

### Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider.** Client type *Confidential*.
2. Redirect URI (strict): `https://rooster.example.com/api/auth/callback/authentik`.
3. Scopes: the default `openid`, `email` and `profile` mappings. Make sure the email is marked verified (Authentik's default `email` mapping sends `email_verified: true` only if you configure it; otherwise add a scope mapping that returns `{"email": request.user.email, "email_verified": True}`).
4. Create an **Application** using the provider, with the slug `rooster`.
5. Discovery URL: `https://sso.example.com/application/o/rooster/.well-known/openid-configuration`.

### Keycloak

1. **Clients → Create client**, type *OpenID Connect*, client ID `rooster`, with **Client authentication** on.
2. Valid redirect URIs: `https://rooster.example.com/api/auth/callback/keycloak`.
3. Discovery URL: `https://kc.example.com/realms/<realm>/.well-known/openid-configuration`.
4. Users need a verified email in Keycloak (*Email verified* on the user, or verification enabled in the realm).

## Troubleshooting

| Symptom | Cause |
|---|---|
| The server exits with code 78 at boot | No provider configured, or invalid JSON in `ROOSTER_OIDC_PROVIDERS`. The log lists each problem. |
| `redirect_uri_mismatch` at the provider | The registered URI differs from `${ROOSTER_BASE_URL}/api/auth/callback/<id>`, often because of `http` vs `https` or a trailing slash. |
| "You're not on the list" after signing in | The email is not allowed. Add it to `ROOSTER_ALLOWED_EMAILS`, Admin → Sign-in, or invite the person to an org. |
| Sign-in loops back to the login page | Cookies are rejected. Serve rooster over HTTPS, set `ROOSTER_BASE_URL` to the public URL, and set `ROOSTER_TRUST_PROXY=true` behind a reverse proxy. |
| The iPhone app asks to sign in again after installing | Expected: an installed iOS web app has its own storage (02 §13.5). |
