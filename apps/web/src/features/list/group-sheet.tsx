import { Inbox, Layers } from 'lucide-react';
import type { ReactNode } from 'react';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';

export interface GroupChoice {
  id: string;
  name: string;
  inbox?: boolean | undefined;
}

export interface GroupSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Move to" (swipe, selection mode) or "Group" (the accessory bar, the detail sheet). */
  title: string;
  groups: readonly GroupChoice[];
  /** The group the task is in now (checked). */
  current?: string | undefined;
  /** The sheet closes itself after a pick. */
  onPick: (groupId: string) => void;
  subject?: ReactNode;
  isStatic?: boolean;
}

/** The phone's group picker (02 §13.2–13.4): the groups in list order as 48 px rows. */
export function GroupSheet({
  isOpen,
  onOpenChange,
  title,
  groups,
  current,
  onPick,
  subject,
  isStatic = false,
}: GroupSheetProps) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      description={subject}
      isStatic={isStatic}
    >
      <div className="flex flex-col" data-testid="group-sheet">
        {groups.map((group) => (
          <SheetOption
            key={group.id}
            icon={group.inbox ? Inbox : Layers}
            label={group.name}
            {...(current !== undefined
              ? { checked: group.id === current, 'aria-pressed': group.id === current }
              : {})}
            onPress={() => {
              onPick(group.id);
              onOpenChange(false);
            }}
          />
        ))}
      </div>
    </BottomSheet>
  );
}
