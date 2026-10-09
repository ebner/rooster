import { UserX } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../../ui/avatar';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { TextField } from '../../ui/input';
import { memberOptions, type Person } from './members';

export interface AssigneeSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  members: readonly Person[];
  meId: string;
  /** The assignee every target task has (null: unassigned); undefined when they differ. */
  current: string | null | undefined;
  onPick: (userId: string | null) => void;
  /** A muted line under the title: the task (or "3 tasks") the sheet acts on. */
  subject?: ReactNode;
  isStatic?: boolean;
}

/**
 * The phone's assignee picker (02 §13.4): the desktop picker's choices as 48 px rows with a
 * filter field. Picking closes the sheet.
 */
export function AssigneeSheet({
  isOpen,
  onOpenChange,
  members,
  meId,
  current,
  onPick,
  subject,
  isStatic = false,
}: AssigneeSheetProps) {
  const { t } = useTranslation('people');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);
  const options = useMemo(
    () => memberOptions(members, meId, query, t('unassigned')),
    [members, meId, query, t],
  );
  const pick = (userId: string | null) => {
    onPick(userId);
    onOpenChange(false);
  };

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('picker.list')}
      description={subject}
      isStatic={isStatic}
    >
      <div className="px-2 pb-2">
        <TextField
          label={t('picker.filter')}
          hideLabel
          placeholder={t('picker.placeholder')}
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const first = options[0];
            if (first) pick(first.userId);
          }}
        />
      </div>
      <div className="flex flex-col" data-testid="assignee-sheet">
        {options.length === 0 && (
          <p className="px-3 py-3 text-sm text-text-muted">{t('picker.empty')}</p>
        )}
        {options.map((option) => (
          <SheetOption
            key={option.userId ?? 'none'}
            data-user-id={option.userId ?? 'none'}
            {...(option.member
              ? {
                  leading: (
                    <Avatar
                      id={option.member.userId}
                      name={option.member.name}
                      src={option.member.image ?? undefined}
                      size={24}
                      decorative
                    />
                  ),
                }
              : { icon: UserX })}
            label={
              option.member ? (
                <>
                  {option.member.name}
                  {option.userId === meId && (
                    <span className="ms-1 text-text-muted">{t('picker.you')}</span>
                  )}
                </>
              ) : (
                t('unassigned')
              )
            }
            checked={current !== undefined && option.userId === current}
            onPress={() => pick(option.userId)}
          />
        ))}
      </div>
    </BottomSheet>
  );
}
