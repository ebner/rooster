import { Button, Layout, type LayoutProps, styles } from './layout.tsx';

type Frame = Omit<LayoutProps, 'children' | 'preview'>;

/** Admin → System's test email (ADR 0059): proof that rooster can deliver to this address. */
export function TestEmail(props: Frame & { sentBy: string; when: string; url: string }) {
  const { t } = props;
  return (
    <Layout {...props} preview={t('test.preview', { host: props.host })}>
      <p style={styles.heading}>{t('test.heading')}</p>
      <p style={{ ...styles.body, marginTop: '8px' }}>
        {t('test.body', { host: props.host, name: props.sentBy, when: props.when })}
      </p>
      <p style={{ ...styles.secondary, marginTop: '8px' }}>{t('test.next')}</p>
      <Button href={props.url}>{t('test.open')}</Button>
    </Layout>
  );
}
