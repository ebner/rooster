import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';

/**
 * A row's org in All organisations (ADR 0073 A2): the org's avatar (its emoji or initial in its
 * colour) and name, muted like Today's group chip. Phones show the avatar only. `draft` is the
 * new row's chip: where the task will go (the default org, or the one `^org` names).
 */
export function OrgChip({
  org,
  draft = false,
  className,
}: {
  org: Pick<Org, 'id' | 'name' | 'avatarEmoji' | 'color'>;
  draft?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('views');
  return (
    <span
      data-testid={draft ? 'draft-org-chip' : 'org-chip'}
      data-org-id={org.id}
      className={cn(
        'inline-flex h-chip max-w-date-cell shrink-0 items-center gap-1 rounded-xs border ps-0.5 pe-1.5 text-xs text-text-muted',
        draft ? 'border-dashed border-border-strong' : 'border-border',
        'max-tablet:border-transparent max-tablet:pe-0.5',
        className,
      )}
    >
      <span className="sr-only">
        {t(draft ? 'all.draftOrg' : 'all.rowOrg', { name: org.name })}
      </span>
      <Avatar
        id={org.id}
        name={org.name}
        emoji={org.avatarEmoji}
        color={org.color}
        shape="square"
        size={16}
        decorative
      />
      <span aria-hidden className="truncate max-tablet:hidden">
        {org.name}
      </span>
    </span>
  );
}
