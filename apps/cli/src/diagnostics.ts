import { clean } from './output/color.ts';
import type { Runtime } from './runtime.ts';

/** A PAT, or whatever follows `Bearer ` up to a quote: an exception may quote a header. */
const CREDENTIAL_RE = /rooster_pat_[A-Za-z0-9]+|\bBearer\s[^"']*/gi;

/**
 * Diagnostic text as it may be printed: the credentials this invocation used (each line of
 * them too, since a malformed one may span lines) and anything shaped like one are redacted,
 * and control characters are removed (a server value can end up in an exception).
 */
export function safeDiagnostic(text: string, runtime: Pick<Runtime, 'io' | 'usedTokens'>): string {
  let out = text;
  const secrets = [runtime.io.env.ROOSTER_TOKEN ?? '', ...runtime.usedTokens].flatMap((s) => [
    s,
    ...s.split(/\s+/),
  ]);
  for (const secret of secrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return clean(out.replace(CREDENTIAL_RE, '[redacted]'));
}
