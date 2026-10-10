import type { DescribedNotification } from '../describe.ts';
import { Button, Layout, type LayoutProps, styles } from './layout.tsx';

type Frame = Omit<LayoutProps, 'children' | 'preview'>;

/** A task reminder (FR-REM-3): always sent at once, never batched (ADR 0049 §2.3). */
export function ReminderEmail(props: Frame & { item: DescribedNotification; url: string }) {
  const { t, item } = props;
  const when = item.when ?? item.event;
  return (
    <Layout {...props} preview={`${item.subject} · ${when}`}>
      <p style={styles.secondary}>{item.event}</p>
      <p style={{ ...styles.heading, marginTop: '8px' }}>{item.subject}</p>
      <p style={{ ...styles.body, marginTop: '8px' }}>{when}</p>
      <Button href={props.url}>{t('action.openTask')}</Button>
    </Layout>
  );
}
