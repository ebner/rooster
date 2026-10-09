import { useTranslation } from 'react-i18next';
import { useDateLabel, type ViewerDateContext } from '../dates';

/** A due snapshot of an activity entry or a notification (`{dueDate, dueTime}` or null). */
export type DueSnapshot = { dueDate: string | null; dueTime: string | null } | null | undefined;

/**
 * "to Fri 14:00" / "removed the due date" style text for a due change: the plain relative label
 * (02 §8.3) inside a sentence, without the due colours of a task row.
 */
export function DueText({ due, ctx }: { due: DueSnapshot; ctx: ViewerDateContext }) {
  const { t } = useTranslation('collab');
  const info = useDateLabel(
    { dueDate: due?.dueDate ?? null, dueTime: due?.dueTime ?? null, dueTz: null, startDate: null },
    ctx,
  );
  return <span className="font-medium text-text">{info?.label ?? t('activity.noDate')}</span>;
}
