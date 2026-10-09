import type { Locale } from '@rooster/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { mailT } from './i18n.ts';
import { mailTheme as theme } from './theme.ts';

/**
 * The pages behind every unsubscribe link (06 §2.6): `confirm` (GET, a button that POSTs to the
 * same URL), `done` (after the POST) and `invalid` (a bad token).
 */
export type UnsubscribeView =
  | { kind: 'confirm'; category: string }
  | { kind: 'done'; category: string }
  | { kind: 'invalid' };

export function unsubscribePage(input: {
  locale: Locale;
  view: UnsubscribeView;
  appUrl: string;
}): string {
  const t = mailT(input.locale);
  const { view } = input;
  const title =
    view.kind === 'confirm'
      ? t('unsubscribe.confirmTitle')
      : view.kind === 'done'
        ? t('unsubscribe.title')
        : t('unsubscribe.invalidTitle');
  const text = { margin: '0 0 12px', fontSize: '16px', lineHeight: '24px' };
  const category = view.kind === 'invalid' ? '' : t(`category.${view.category}`);
  const markup = renderToStaticMarkup(
    <html lang={input.locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${title} · ${t('common:app.name')}`}</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: '48px 16px',
          backgroundColor: theme.color.page,
          color: theme.color.text,
          fontFamily: theme.font.sans,
        }}
      >
        <main
          style={{
            maxWidth: `${theme.width}px`,
            margin: '0 auto',
            padding: '32px 24px',
            backgroundColor: theme.color.card,
            border: `1px solid ${theme.color.border}`,
            borderRadius: `${theme.radius.md}px`,
          }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: '24px', lineHeight: '32px' }}>{title}</h1>
          {view.kind === 'confirm' ? (
            <>
              <p style={text}>{t('unsubscribe.confirmBody', { category })}</p>
              {/* No action: the form posts to this same URL (CSP form-action 'self'). */}
              <form method="post" style={{ margin: '24px 0 0' }}>
                <button
                  type="submit"
                  style={{
                    padding: '8px 16px',
                    border: 0,
                    borderRadius: `${theme.radius.sm}px`,
                    backgroundColor: theme.color.button,
                    color: theme.color.onAccent,
                    font: 'inherit',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {t('unsubscribe.confirmButton', { category })}
                </button>
              </form>
            </>
          ) : view.kind === 'done' ? (
            <>
              <p style={text}>{t('unsubscribe.body', { category })}</p>
              <p style={{ ...text, color: theme.color.secondary }}>{t('unsubscribe.settings')}</p>
            </>
          ) : (
            <p style={text}>{t('unsubscribe.invalidBody')}</p>
          )}
          <p style={{ margin: '24px 0 0' }}>
            <a href={input.appUrl} style={{ color: theme.color.accent }}>
              {t('unsubscribe.open')}
            </a>
          </p>
        </main>
      </body>
    </html>,
  );
  return `<!doctype html>${markup}`;
}
