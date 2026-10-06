import { TAG_NAME_MAX } from '@rooster/core/limits';
import type { Tag } from '@rooster/core/schemas';
import type { TagColor } from '@rooster/tokens';
import { GitMerge, MoreHorizontal, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { DialogTrigger } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { ColorPicker } from '../../ui/color-picker';
import { IconButton } from '../../ui/icon-button';
import { InlineTextField } from '../../ui/inline-text-field';
import {
  Menu,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from '../../ui/menu';
import { Popover } from '../../ui/popover';
import { SettingsSection } from '../settings/settings-section';
import { TagDot } from './tag-dot';

export interface TagsSectionProps {
  tags: readonly Tag[];
  onRename: (id: string, name: string) => unknown;
  onRecolor: (id: string, color: TagColor) => unknown;
  onMerge: (id: string, intoId: string) => unknown;
  onDelete: (id: string) => unknown;
}

type Confirm = { kind: 'merge'; intoId: string } | { kind: 'delete' };

/**
 * Settings → Tags (FR-TAG-3): rename inline, recolour, merge into another tag and delete. The
 * irreversible ones (merge, delete) ask inline under the row, never in a modal (02 §1).
 */
export function TagsSection({ tags, onRename, onRecolor, onMerge, onDelete }: TagsSectionProps) {
  const { t } = useTranslation('tags');
  const sorted = [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return (
    <SettingsSection id="tags" title={t('settings.title')} description={t('settings.description')}>
      {sorted.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('settings.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label={t('settings.title')}>
          {sorted.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              others={sorted.filter((o) => o.id !== tag.id)}
              onRename={onRename}
              onRecolor={onRecolor}
              onMerge={onMerge}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function TagRow({
  tag,
  others,
  onRename,
  onRecolor,
  onMerge,
  onDelete,
}: {
  tag: Tag;
  others: readonly Tag[];
} & Omit<TagsSectionProps, 'tags'>) {
  const { t } = useTranslation('tags');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const colorButton = useRef<HTMLButtonElement>(null);
  const into = confirm?.kind === 'merge' ? others.find((o) => o.id === confirm.intoId) : undefined;

  const act = async (fn: () => unknown) => {
    setBusy(true);
    try {
      await fn();
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-2" data-testid="tag-settings-row" data-tag={tag.name}>
      <div className="flex min-h-control items-center gap-3">
        <DialogTrigger>
          <Button
            ref={colorButton}
            variant="ghost"
            size="sm"
            aria-label={t('settings.color', { name: tag.name })}
            className="px-2"
          >
            <TagDot color={tag.color} className="size-3" />
          </Button>
          <Popover placement="bottom start" aria-label={t('settings.color', { name: tag.name })}>
            <div className="p-2">
              <ColorPicker
                label={t('settings.color', { name: tag.name })}
                value={tag.color}
                onChange={(color) => onRecolor(tag.id, color)}
              />
            </div>
          </Popover>
        </DialogTrigger>
        <InlineTextField
          label={t('settings.rename', { name: tag.name })}
          value={tag.name}
          maxLength={TAG_NAME_MAX}
          onCommit={(name) => onRename(tag.id, name)}
          className="min-w-0 flex-1"
        />
        <Chip color={tag.color} className="max-tablet:hidden">
          {tag.name}
        </Chip>
        <MenuTrigger>
          <IconButton
            icon={MoreHorizontal}
            aria-label={t('settings.options', { name: tag.name })}
          />
          <MenuPopover placement="bottom end">
            <Menu aria-label={t('settings.options', { name: tag.name })}>
              {others.length > 0 && (
                <SubmenuTrigger>
                  <MenuItem icon={GitMerge}>{t('settings.merge')}</MenuItem>
                  <MenuPopover placement="start top">
                    <Menu
                      aria-label={t('settings.mergeLabel', { name: tag.name })}
                      onAction={(key) => setConfirm({ kind: 'merge', intoId: String(key) })}
                    >
                      {others.map((o) => (
                        <MenuItem key={o.id} id={o.id} textValue={o.name}>
                          <span className="flex items-center gap-2">
                            <TagDot color={o.color} />
                            {o.name}
                          </span>
                        </MenuItem>
                      ))}
                    </Menu>
                  </MenuPopover>
                </SubmenuTrigger>
              )}
              {others.length > 0 && <MenuSeparator />}
              <MenuItem icon={Trash2} tone="danger" onAction={() => setConfirm({ kind: 'delete' })}>
                {t('settings.delete', { name: tag.name })}
              </MenuItem>
            </Menu>
          </MenuPopover>
        </MenuTrigger>
      </div>
      {confirm && (
        <fieldset
          aria-label={
            confirm.kind === 'delete' ? t('settings.deleteAction') : t('settings.mergeAction')
          }
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 rounded-md border-0 bg-bg-subtle p-3 text-sm text-text-secondary"
        >
          <p className="min-w-0 flex-1">
            {confirm.kind === 'delete'
              ? t('settings.deleteConfirm', { name: tag.name })
              : t('settings.mergeConfirm', { name: tag.name, into: into?.name ?? '' })}
          </p>
          <Button variant="secondary" size="sm" onPress={() => setConfirm(null)}>
            {t('settings.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            isLoading={busy}
            onPress={() =>
              act(() =>
                confirm.kind === 'delete' ? onDelete(tag.id) : onMerge(tag.id, confirm.intoId),
              )
            }
          >
            {confirm.kind === 'delete' ? t('settings.deleteAction') : t('settings.mergeAction')}
          </Button>
        </fieldset>
      )}
    </li>
  );
}
