import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { LinkCard } from './link-card';
import { MarkdownEditor, type MarkdownEditorProps } from './markdown-editor';

function EditorSample({
  label,
  initial,
  ...props
}: { label: string; initial: string } & Omit<
  MarkdownEditorProps,
  'value' | 'onChange' | 'ariaLabel'
>) {
  const [value, setValue] = useState(initial);
  return (
    <Specimen label={label} className="w-full max-w-pane">
      <div className="w-pane max-w-full rounded-md border border-border bg-bg-elevated p-4">
        <MarkdownEditor {...props} value={value} onChange={setValue} ariaLabel={label} />
      </div>
    </Specimen>
  );
}

/** Kitchen-sink entry for WP 3.3: the description editor in its states. */
export function EditorSection() {
  const { t, i18n } = useTranslation('editor');
  return (
    // Remount on language switch so the samples show the other language's text.
    <Section key={i18n.language} id="editor" title={t('dev.section')}>
      <Group title={t('dev.section')} className="flex-col">
        <EditorSample label={t('dev.empty')} initial="" />
        <EditorSample label={t('dev.collapsed')} initial={t('dev.sample')} />
        <EditorSample label={t('dev.toolbar')} initial={t('dev.short')} forceToolbar="buttons" />
        <EditorSample label={t('link.label')} initial={t('dev.short')} forceToolbar="link" />
        <Specimen label={t('dev.linkCard')}>
          <LinkCard href="https://example.com/team/q3-plan" onEdit={() => {}} onRemove={() => {}} />
        </Specimen>
        <EditorSample label={t('dev.readOnly')} initial={t('dev.sample')} readOnly />
      </Group>
    </Section>
  );
}
