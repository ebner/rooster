import type { Locale } from '@rooster/i18n';
import type { CSSProperties, ReactNode } from 'react';
import type { MailT } from '../i18n.ts';
import { mailLogo } from '../logo.ts';
import { mailTheme as theme } from '../theme.ts';

// Email-safe markup: tables for layout, inline styles only, no CSS variables or web fonts.

/** The header logo's Content-ID: every message carries the PNG inline (`mailLogo`). */
export const logoCid = 'logo@rooster';

export interface UnsubscribeLink {
  /** Already localised, e.g. "Unsubscribe from emails about mentions". */
  label: string;
  url: string;
}

export interface LayoutProps {
  locale: Locale;
  t: MailT;
  /** Inbox preview text (hidden in the body). */
  preview: string;
  /** The instance host named in the footer ("…you use rooster at tasks.example.com"). */
  host: string;
  /** Per-category unsubscribe links (FR-NOT-3); none for invites. */
  unsubscribe: readonly UnsubscribeLink[];
  /** Settings → Notifications; omitted when the recipient has no account (invites). */
  settingsUrl?: string;
  children: ReactNode;
}

const text = (size: keyof typeof theme.size, color: string): CSSProperties => ({
  margin: 0,
  fontFamily: theme.font.sans,
  fontSize: `${theme.size[size].size}px`,
  lineHeight: `${theme.size[size].lineHeight}px`,
  color,
});

export const styles = {
  heading: { ...text('lg', theme.color.text), fontWeight: 600 },
  body: text('md', theme.color.text),
  secondary: text('base', theme.color.secondary),
  muted: text('sm', theme.color.muted),
  small: text('xs', theme.color.muted),
  link: { color: theme.color.accent, textDecoration: 'underline' },
} satisfies Record<string, CSSProperties>;

export function Layout(props: LayoutProps) {
  const { t } = props;
  const pad = `${theme.space['8']}px ${theme.space['6']}px`;
  return (
    <html lang={props.locale}>
      <head>
        <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: theme.color.page }}>
        <div
          data-skip-in-text="true"
          style={{ display: 'none', overflow: 'hidden', maxHeight: 0, opacity: 0 }}
        >
          {props.preview}
        </div>
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ backgroundColor: theme.color.page }}
        >
          <tbody>
            <tr>
              <td align="center" style={{ padding: `${theme.space['8']}px ${theme.space['3']}px` }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ maxWidth: `${theme.width}px` }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: `0 0 ${theme.space['4']}px` }}>
                        {/* The app's mark and Fraunces name as a picture (no SVG or web fonts in
                            mail); the alt text keeps the name where images are blocked. */}
                        <img
                          src={`cid:${logoCid}`}
                          width={mailLogo.width}
                          height={mailLogo.height}
                          alt={t('common:app.name')}
                          style={{
                            display: 'block',
                            border: 0,
                            outline: 'none',
                            fontFamily: theme.font.wordmark,
                            fontSize: `${theme.size.xl.size}px`,
                            lineHeight: `${mailLogo.height}px`,
                            fontWeight: 700,
                            color: theme.color.text,
                          }}
                        />
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          backgroundColor: theme.color.card,
                          border: `1px solid ${theme.color.border}`,
                          borderRadius: `${theme.radius.md}px`,
                          padding: pad,
                        }}
                      >
                        {props.children}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: `${theme.space['5']}px ${theme.space['1']}px 0` }}>
                        <p style={styles.small}>{t('footer.reason', { host: props.host })}</p>
                        {props.unsubscribe.map((link) => (
                          <p key={link.url} style={{ ...styles.small, marginTop: '4px' }}>
                            <a href={link.url} style={{ color: theme.color.muted }}>
                              {link.label}
                            </a>
                          </p>
                        ))}
                        {props.settingsUrl === undefined ? null : (
                          <p style={{ ...styles.small, marginTop: '4px' }}>
                            <a href={props.settingsUrl} style={{ color: theme.color.muted }}>
                              {t('footer.settings')}
                            </a>
                          </p>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

/** A bulletproof-ish button: a padded link in a table cell (Outlook ignores link padding). */
export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ marginTop: '24px' }}>
      <tbody>
        <tr>
          <td
            style={{
              backgroundColor: theme.color.button,
              borderRadius: `${theme.radius.sm}px`,
            }}
          >
            <a
              href={href}
              style={{
                display: 'inline-block',
                padding: `${theme.space['2']}px ${theme.space['4']}px`,
                fontFamily: theme.font.sans,
                fontSize: `${theme.size.base.size}px`,
                lineHeight: `${theme.size.base.lineHeight}px`,
                fontWeight: 600,
                color: theme.color.onAccent,
                textDecoration: 'none',
              }}
            >
              {children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export interface ListItem {
  key: string;
  title: string;
  url: string;
  /** Secondary line: the due label, the org, an event. */
  meta?: string;
  /** A quoted comment excerpt. */
  quote?: string;
}

/** Rows of tasks or notifications, separated by hairlines. */
export function ItemList({ items }: { items: readonly ListItem[] }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
      <tbody>
        {items.map((item) => (
          <tr key={item.key}>
            <td
              style={{
                padding: `${theme.space['3']}px 0`,
                borderBottom: `1px solid ${theme.color.border}`,
              }}
            >
              <p style={{ ...styles.body, fontWeight: 500 }}>
                <a href={item.url} style={{ color: theme.color.text, textDecoration: 'none' }}>
                  {item.title}
                </a>
              </p>
              {item.meta === undefined ? null : (
                <p style={{ ...styles.muted, marginTop: '2px' }}>{item.meta}</p>
              )}
              {item.quote === undefined ? null : (
                <p style={{ ...styles.secondary, marginTop: '4px' }}>{item.quote}</p>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
