import pkg from '../package.json' with { type: 'json' };

/** The CLI version (the root release version; 07 §1). */
export const CLI_VERSION: string = pkg.version;

/** `X-Rooster-Client` (06 §1), recorded as `via` in activity entries. */
export const CLIENT_NAME = `cli/${CLI_VERSION}`;

/** The major version of a semver string, or null when it does not parse. */
export function majorOf(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}
