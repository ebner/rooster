import type { TagColor } from '@rooster/tokens';
import { type FormEvent, useState } from 'react';
import { Form, Heading } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CreateOrgInput } from '../../data/types';
import { Avatar } from '../../ui/avatar';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ColorPicker } from '../../ui/color-picker';
import { EmojiPicker } from '../../ui/emoji-picker';
import { TextField } from '../../ui/input';

/** `task_group.name` and org names share the 80-character limit (05 §3). */
export const orgNameMaxLength = 80;

export interface CreateOrgFormProps {
  defaultColor: TagColor;
  onSubmit: (input: CreateOrgInput) => Promise<void> | void;
  onCancel: () => void;
  /** Kitchen sink: show the failure state. */
  initialError?: string | undefined;
  /** Focus the name field on mount (the popover); off for static previews. */
  autoFocus?: boolean;
}

/** The inline "New organisation" form shown in an anchored popover (no modal, 02 §1). */
export function CreateOrgForm({
  defaultColor,
  onSubmit,
  onCancel,
  initialError,
  autoFocus = true,
}: CreateOrgFormProps) {
  const { t } = useTranslation('shell');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [color, setColor] = useState<TagColor>(defaultColor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const trimmed = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit({ name: trimmed, avatarEmoji: emoji, color });
    } catch {
      setError(t('createOrg.failed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Form onSubmit={submit} className="flex w-date-popover max-w-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2">
        <Avatar
          id="new-org"
          name={trimmed || t('createOrg.title')}
          emoji={emoji}
          color={color}
          shape="square"
          size={24}
          decorative
        />
        <Heading slot="title" className="text-base font-semibold">
          {t('createOrg.title')}
        </Heading>
      </div>
      <TextField
        label={t('createOrg.name')}
        placeholder={t('createOrg.namePlaceholder')}
        value={name}
        onChange={setName}
        maxLength={orgNameMaxLength}
        autoFocus={autoFocus}
        isRequired
      />
      <EmojiPicker label={t('createOrg.icon')} value={emoji} onChange={setEmoji} name={trimmed} />
      <ColorPicker label={t('createOrg.color')} value={color} onChange={setColor} />
      {error && (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          {t('createOrg.cancel')}
        </Button>
        <Button variant="primary" type="submit" isDisabled={!trimmed} isLoading={pending}>
          {t('createOrg.submit')}
        </Button>
      </div>
    </Form>
  );
}
