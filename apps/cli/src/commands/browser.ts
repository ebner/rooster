import { t } from '../i18n.ts';
import { openableUrl } from '../launch.ts';
import type { Runtime } from '../runtime.ts';

/**
 * Prints `url` and opens it in the browser when it is safe to: an https (or loopback http)
 * page of the profile's own server. Anything else is only printed.
 */
export async function openInBrowser(runtime: Runtime, url: string): Promise<boolean> {
  const { out } = runtime;
  if (out.json) out.data({ url });
  else out.line(url);
  const server = runtime.serverOrNull();
  const href = server === null ? null : openableUrl(url, server);
  if (href === null) {
    out.notice(t('open.notOpened'));
    return false;
  }
  const opened = await runtime.io.openUrl(href);
  if (!opened) out.notice(t('open.failed'));
  return opened;
}
