import type { SavedViewQuery, Tag } from '@rooster/core/schemas';
import { Lock, UserRound, Users, UserX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Org, OrgMember } from '../../data/types';
import { Avatar } from '../../ui/avatar';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { SegmentedControl } from '../../ui/segmented-control';
import { announce } from '../list/announcer';
import { TagDot } from '../tags/tag-dot';
import { viewDueFilters, viewStatusFilters, viewTagsMax } from './query';
import { useAssigneeLabel } from './query-chips';
import { ViewNameInput } from './saved-view-header';
import type { ViewEditor } from './use-view-editor';

function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col pt-3">
      <h3 className="px-3 pb-1 text-xs font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

export interface QuerySheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  org: Org;
  userId: string;
  editor: ViewEditor;
  tags: readonly Tag[];
  members: readonly OrgMember[];
  isStatic?: boolean;
}

/**
 * Phones (02 §10.2, §13): the view's name and query in a bottom sheet, opened from the
 * header: tags (any or all), person, due, status and Private/Shared, each saved at once.
 */
export function QuerySheet({
  isOpen,
  onOpenChange,
  org,
  userId,
  editor,
  tags,
  members,
  isStatic = false,
}: QuerySheetProps) {
  const { t } = useTranslation('views');
  const { t: tPeople } = useTranslation('people');
  const { draft } = editor;
  const { query } = draft;
  const assigneeLabel = useAssigneeLabel(members);
  const set = (patch: Partial<SavedViewQuery>, message: string) => {
    editor.setQuery({ ...query, ...patch });
    announce(message);
  };
  const people: { id: SavedViewQuery['assignee']; leading: ReactNode }[] = [
    { id: 'anyone', leading: <Users className="size-5 text-text-secondary" aria-hidden /> },
    { id: 'me', leading: <UserRound className="size-5 text-text-secondary" aria-hidden /> },
    { id: 'unassigned', leading: <UserX className="size-5 text-text-secondary" aria-hidden /> },
    ...members.map((m) => ({
      id: m.userId,
      leading: (
        <Avatar id={m.userId} name={m.name} src={m.image ?? undefined} size={20} decorative />
      ),
    })),
  ];
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('saved.chips.sheet')}
      isStatic={isStatic}
    >
      <div data-testid="view-sheet" className="flex flex-col">
        <div className="flex px-3 pt-1">
          <ViewNameInput
            name={draft.name}
            onCommit={editor.setName}
            className="h-control-lg flex-1 bg-bg-subtle px-3"
          />
        </div>
        <SheetSection title={t('saved.chips.tagsPicker')}>
          {tags.map((tag) => {
            const checked = query.tags.includes(tag.id);
            return (
              <SheetOption
                key={tag.id}
                leading={<TagDot color={tag.color} className="mx-1.5" />}
                label={tag.name}
                checked={checked}
                aria-pressed={checked}
                isDisabled={!checked && query.tags.length >= viewTagsMax}
                onPress={() =>
                  set(
                    {
                      tags: checked
                        ? query.tags.filter((id) => id !== tag.id)
                        : [...query.tags, tag.id],
                    },
                    tag.name,
                  )
                }
              />
            );
          })}
          {query.tags.length > 1 && (
            <div className="px-3 pt-2">
              <SegmentedControl
                label={t('saved.tagMode.label')}
                hideLabel
                options={[
                  { id: 'any', label: t('saved.tagMode.any') },
                  { id: 'all', label: t('saved.tagMode.all') },
                ]}
                value={query.tagMode}
                onChange={(tagMode) => set({ tagMode }, t(`saved.tagMode.${tagMode}`))}
              />
            </div>
          )}
        </SheetSection>
        {!org.isPersonal && (
          <SheetSection title={t('saved.chips.assigneeMenu')}>
            {people.map(({ id, leading }) => (
              <SheetOption
                key={id}
                leading={leading}
                label={assigneeLabel(id)}
                {...(id === userId ? { detail: tPeople('picker.you') } : {})}
                checked={query.assignee === id}
                aria-pressed={query.assignee === id}
                onPress={() => set({ assignee: id }, assigneeLabel(id))}
              />
            ))}
          </SheetSection>
        )}
        <SheetSection title={t('saved.chips.dueMenu')}>
          {viewDueFilters.map((due) => (
            <SheetOption
              key={due}
              label={t(`saved.due.${due}`)}
              checked={query.due === due}
              aria-pressed={query.due === due}
              onPress={() => set({ due }, t(`saved.due.${due}`))}
            />
          ))}
        </SheetSection>
        <SheetSection title={t('saved.chips.statusMenu')}>
          {viewStatusFilters.map((status) => (
            <SheetOption
              key={status}
              label={t(`saved.status.${status}`)}
              checked={query.status === status}
              aria-pressed={query.status === status}
              onPress={() => set({ status }, t(`saved.status.${status}`))}
            />
          ))}
        </SheetSection>
        {!org.isPersonal && (
          <SheetSection title={t('saved.chips.sharingMenu')}>
            {(['private', 'shared'] as const).map((id) => (
              <SheetOption
                key={id}
                icon={id === 'shared' ? Users : Lock}
                label={t(`saved.sharing.${id}`)}
                checked={draft.shared === (id === 'shared')}
                aria-pressed={draft.shared === (id === 'shared')}
                onPress={() => {
                  editor.setShared(id === 'shared');
                  announce(t(`saved.sharing.${id}`));
                }}
              />
            ))}
            {draft.shared && (
              <p className="px-3 pt-1 text-sm text-text-muted">
                {t('saved.sharedNote', { org: org.name })}
              </p>
            )}
          </SheetSection>
        )}
      </div>
    </BottomSheet>
  );
}
