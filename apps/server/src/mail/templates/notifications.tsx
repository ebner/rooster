import type { DescribedNotification } from '../describe.ts';
import { Button, ItemList, Layout, type LayoutProps, styles } from './layout.tsx';

type Frame = Omit<LayoutProps, 'children' | 'preview'>;

/** One notification, sent at once (`emailMode: 'immediate'`). */
export function NotificationEmail(props: Frame & { item: DescribedNotification; url: string }) {
  const { t, item } = props;
  return (
    <Layout {...props} preview={`${item.event}: ${item.subject}`}>
      <p style={styles.secondary}>{item.event}</p>
      <p style={{ ...styles.heading, marginTop: '8px' }}>{item.subject}</p>
      {item.quote === undefined ? null : (
        <p style={{ ...styles.body, marginTop: '16px' }}>{item.quote}</p>
      )}
      <Button href={props.url}>
        {item.path === '/inbox' ? t('action.openInbox') : t('action.openTask')}
      </Button>
    </Layout>
  );
}

/** Several notifications in one email (`emailMode: 'batch'`, every 15 minutes). */
export function BatchEmail(
  props: Frame & {
    items: readonly (DescribedNotification & { key: string; url: string })[];
    inboxUrl: string;
  },
) {
  const { t, items } = props;
  return (
    <Layout {...props} preview={items.map((i) => i.event).join(' · ')}>
      <p style={styles.heading}>{t('batch.heading')}</p>
      <div style={{ marginTop: '8px' }}>
        <ItemList
          items={items.map((i) => ({
            key: i.key,
            title: i.subject,
            url: i.url,
            meta: i.event,
            ...(i.quote === undefined ? {} : { quote: i.quote }),
          }))}
        />
      </div>
      <Button href={props.inboxUrl}>{t('action.openInbox')}</Button>
    </Layout>
  );
}
