import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton, Input as AriaInput } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';

export interface InlineTextFieldProps {
  /** Accessible name of the value, e.g. "Organisation name". */
  label: string;
  value: string;
  /** Called with the trimmed new value when it changed and is not empty. */
  onCommit: (value: string) => void;
  maxLength?: number;
  isDisabled?: boolean;
  /** Typography of both the text and the input, so editing never shifts layout. */
  textClassName?: string | undefined;
  className?: string | undefined;
  'data-force'?: string;
}

/**
 * Text that turns into an input in place (02 §1: no dialogs for renaming).
 * Enter or blur commits; Escape restores the previous value. An empty value is
 * never committed.
 */
export function InlineTextField({
  label,
  value,
  onCommit,
  maxLength,
  isDisabled = false,
  textClassName = 'text-base',
  className,
  'data-force': force,
}: InlineTextFieldProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  const finish = (commit: boolean, refocus: boolean) => {
    const next = draft.trim();
    if (commit && next && next !== value) onCommit(next);
    restoreFocus.current = refocus;
    setEditing(false);
  };

  const shared = cn('min-w-0 rounded-xs px-1.5 py-0.5', textClassName);

  if (!editing) {
    return (
      <AriaButton
        ref={triggerRef}
        isDisabled={isDisabled}
        onPress={() => {
          setDraft(value);
          setEditing(true);
        }}
        aria-label={t('inlineEdit.edit', { label, value })}
        {...(force ? { 'data-force': force } : {})}
        className={cn(
          'group -mx-1.5 inline-flex max-w-full cursor-text items-center gap-2 text-start text-text',
          'hover:bg-bg-subtle data-disabled:cursor-default data-disabled:hover:bg-transparent',
          shared,
          className,
        )}
      >
        <span className="truncate">{value}</span>
        {!isDisabled && (
          <Pencil
            className="size-4 shrink-0 text-icon-subtle opacity-0 transition-opacity duration-(--dur-fade) group-hover:opacity-100 group-focus-ring:opacity-100 pointer-coarse:opacity-100"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        )}
      </AriaButton>
    );
  }

  return (
    <AriaInput
      ref={inputRef}
      aria-label={label}
      value={draft}
      autoFocus
      {...(maxLength === undefined ? {} : { maxLength })}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false, true);
        }
      }}
      className={cn(
        '-mx-1.5 w-full border-0 bg-bg-subtle text-text outline-offset-0',
        shared,
        className,
      )}
    />
  );
}
