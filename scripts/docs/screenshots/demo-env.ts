/**
 * The screenshot stack. The ports are the e2e suite's, so `screenshots.sh` takes the same lock
 * (`/tmp/rooster-e2e.lock`) as every Playwright run in this repo.
 */
export const DEMO = {
  idpPort: 9400,
  idpIssuer: 'http://localhost:9400',
  apiPort: 3181,
  webPort: 5181,
  baseURL: 'http://localhost:5181',
  /** What the screenshots show instead of the local origin (`hideOrigin`). */
  publicURL: 'https://rooster.example.com',
  /** A reserved TLD (RFC 2606): the studio and its people are fictional. */
  domain: 'kestrel-lane.example',
  adminEmail: 'maja.lind@kestrel-lane.example',
  timezone: 'Europe/Stockholm',
} as const;
