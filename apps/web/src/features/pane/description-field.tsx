import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownEditor } from '../editor';

export interface DescriptionFieldProps {
  /** Markdown. */
  value: string;
  /** Called on blur and after 600 ms idle (FR-DET-5), only with a changed value. */
  onChange: (markdown: string) => void;
  autoFocus?: boolean | undefined;
  readOnly?: boolean | undefined;
  /** Esc in the text: back to the list (02 §9.1). */
  onEscape?: (() => void) | undefined;
  onModEnter?: (() => void) | undefined;
}

/**
 * The pane's description (02 §9.2 item 5) behind one small adapter, so the pane does not
 * depend on the editor's internals. Tab belongs to the editor here (list indent), so Tab
 * chords are off inside it (`data-no-chords`).
 */
export const DescriptionField = memo(function DescriptionField({
  value,
  onChange,
  autoFocus,
  readOnly,
  onEscape,
  onModEnter,
}: DescriptionFieldProps) {
  const { t } = useTranslation('pane');
  return (
    <div data-no-chords data-testid="description-field">
      <MarkdownEditor
        value={value}
        onChange={onChange}
        ariaLabel={t('description.label')}
        placeholder={t('description.placeholder')}
        collapsedLines={12}
        autoFocus={autoFocus}
        readOnly={readOnly}
        onEscape={onEscape}
        onModEnter={onModEnter}
      />
    </div>
  );
});
