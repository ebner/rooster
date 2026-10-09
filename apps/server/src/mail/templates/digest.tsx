import { mailTheme as theme } from '../theme.ts';
import { Button, ItemList, Layout, type LayoutProps, type ListItem, styles } from './layout.tsx';

export interface DigestSection {
  id: 'overdue' | 'dueToday' | 'inbox';
  items: readonly ListItem[];
  /** Tasks beyond the listed ones. */
  more: number;
}

/** The daily digest (FR-NOT-3): overdue, due today and new in the Inbox, across orgs. */
export function DigestEmail(
  props: Omit<LayoutProps, 'children' | 'preview'> & {
    date: string;
    sections: readonly DigestSection[];
    todayUrl: string;
  },
) {
  const { t } = props;
  const preview = props.sections
    .map((s) => `${t(`digest.${s.id}`)}: ${s.items.length + s.more}`)
    .join(' · ');
  return (
    <Layout {...props} preview={preview}>
      <p style={styles.heading}>{t('digest.heading')}</p>
      <p style={{ ...styles.secondary, marginTop: '4px' }}>{props.date}</p>
      {props.sections.map((section) => (
        <div key={section.id} style={{ marginTop: '24px' }}>
          <p
            style={{
              ...styles.muted,
              fontWeight: 600,
              color: section.id === 'overdue' ? theme.color.danger : theme.color.secondary,
            }}
          >
            {t(`digest.${section.id}`)}
          </p>
          <ItemList items={section.items} />
          {section.more === 0 ? null : (
            <p style={{ ...styles.muted, marginTop: '8px' }}>
              {t('digest.more', { count: section.more })}
            </p>
          )}
        </div>
      ))}
      <Button href={props.todayUrl}>{t('action.openToday')}</Button>
    </Layout>
  );
}
