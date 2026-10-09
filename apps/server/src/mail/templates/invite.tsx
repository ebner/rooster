import { mailTheme as theme } from '../theme.ts';
import { Button, Layout, type LayoutProps, styles } from './layout.tsx';

/** An email invite (FR-ORG-3): the link is the same one org settings shows for copying. */
export function InviteEmail(
  props: Omit<LayoutProps, 'children' | 'preview' | 'unsubscribe'> & {
    inviter: string | null;
    org: string;
    url: string;
    expires: string;
  },
) {
  const { t, inviter, org } = props;
  const body =
    inviter === null ? t('invite.bodyAnonymous', { org }) : t('invite.body', { inviter, org });
  return (
    <Layout {...props} preview={body} unsubscribe={[]}>
      <p style={styles.heading}>{t('invite.heading', { org })}</p>
      <p style={{ ...styles.body, marginTop: '12px' }}>{body}</p>
      <Button href={props.url}>{t('invite.accept')}</Button>
      <p style={{ ...styles.muted, marginTop: '24px' }}>{t('invite.link')}</p>
      <p style={{ ...styles.muted, marginTop: '4px', wordBreak: 'break-all' }}>
        <a href={props.url} style={{ color: theme.color.accent }}>
          {props.url}
        </a>
      </p>
      <p style={{ ...styles.muted, marginTop: '16px' }}>
        {t('invite.expires', { date: props.expires })}
      </p>
      <p style={{ ...styles.muted, marginTop: '4px' }}>{t('invite.ignore')}</p>
    </Layout>
  );
}
