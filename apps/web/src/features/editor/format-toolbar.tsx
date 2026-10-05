import { type Editor, useEditorState } from '@tiptap/react';
import {
  Bold,
  Check,
  Code,
  ExternalLink,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  type LucideIcon,
  Strikethrough,
  Unlink,
} from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { Toolbar } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Input } from '../../ui/input';
import { popoverSurface } from '../../ui/popover';
import { type HeadingLevel, headingLevels } from './extensions';
import { linkOptions } from './link';

/** Toolbar shortcuts as Kbd strings; the editor binds the same keys (tiptap defaults + Mod+K). */
export const formatShortcuts = {
  bold: 'Mod+B',
  italic: 'Mod+I',
  strike: 'Mod+Shift+S',
  code: 'Mod+E',
  link: 'Mod+K',
  heading: 'Mod+Alt+1',
  bulletList: 'Mod+Shift+8',
  taskList: 'Mod+Shift+9',
  /** Moves focus from the text into the toolbar. */
  focusToolbar: 'Alt+F10',
} as const;

const headingIcon: Record<0 | HeadingLevel, LucideIcon> = {
  0: Heading,
  1: Heading1,
  2: Heading2,
  3: Heading3,
};

/** The next step of the H button's cycle: paragraph → H1 → H2 → H3 → paragraph. */
export function nextHeadingLevel(current: 0 | HeadingLevel): 0 | HeadingLevel {
  return current === 3 ? 0 : ((current + 1) as HeadingLevel);
}

/**
 * A typed link address: adds `https://` to bare domains and `mailto:` to addresses;
 * returns null for anything the link mark would refuse (javascript:, data:, blanks).
 */
export function normalizeHref(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let href = text;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text)) href = `mailto:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.startsWith('/')) href = `https://${text}`;
  const allowed = linkOptions.isAllowedUri(href, { defaultValidate: (url) => Boolean(url) });
  return allowed ? href : null;
}

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  href: string | null;
  heading: 0 | HeadingLevel;
  bulletList: boolean;
  taskList: boolean;
}

function readState(editor: Editor): ToolbarState {
  const level = headingLevels.find((l) => editor.isActive('heading', { level: l })) ?? 0;
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    link: editor.isActive('link'),
    href: (editor.getAttributes('link').href as string | undefined) ?? null,
    heading: level,
    bulletList: editor.isActive('bulletList'),
    taskList: editor.isActive('taskList'),
  };
}

export interface FormatToolbarProps {
  editor: Editor;
  /** Opens straight into the link field (Mod+K, and the kitchen sink). */
  linkMode?: boolean | undefined;
  onLinkModeChange?: ((open: boolean) => void) | undefined;
  /** Kitchen sink: force the tooltips closed so specimens do not overlap. */
  isTooltipOpen?: boolean | undefined;
  /** Focus the link field when it opens (default true; off in the kitchen sink). */
  autoFocusLink?: boolean | undefined;
  className?: string | undefined;
}

/**
 * The bubble toolbar (02 §9.2): B, I, S, code, link, H, bullet list and checklist.
 * Each button names its action and shows its shortcut in the tooltip; the pressed
 * state follows the selection. Arrow keys move between buttons (APG toolbar); Esc
 * returns to the text. Link opens an inline address field in place of the buttons.
 */
export function FormatToolbar({
  editor,
  linkMode = false,
  onLinkModeChange,
  isTooltipOpen,
  autoFocusLink = true,
  className,
}: FormatToolbarProps) {
  const { t } = useTranslation('editor');
  const state = useEditorState({ editor, selector: ({ editor: e }) => readState(e) });
  const tooltip = isTooltipOpen === undefined ? {} : { isTooltipOpen };
  const run = (command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
    command(editor.chain().focus()).run();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (linkMode) onLinkModeChange?.(false);
    editor.commands.focus();
  };

  if (linkMode) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Esc routing for the link field
      <div onKeyDown={onKeyDown} className={cn(popoverSurface, 'flex items-center', className)}>
        <LinkField
          editor={editor}
          href={state.href}
          onDone={() => onLinkModeChange?.(false)}
          isTooltipOpen={isTooltipOpen}
          autoFocus={autoFocusLink}
        />
      </div>
    );
  }

  const button = (
    id: keyof typeof formatShortcuts,
    icon: LucideIcon,
    label: string,
    pressed: boolean,
    onPress: () => void,
  ) => (
    <IconButton
      key={id}
      size="sm"
      icon={icon}
      aria-label={label}
      aria-pressed={pressed}
      shortcut={formatShortcuts[id]}
      preventFocusOnPress
      onPress={onPress}
      className={cn(pressed && 'bg-bg-muted text-text')}
      {...tooltip}
    />
  );

  const nextLevel = nextHeadingLevel(state.heading);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc routing for the toolbar
    <div onKeyDown={onKeyDown} className={className}>
      <Toolbar
        aria-label={t('toolbar.label')}
        className={cn(popoverSurface, 'flex items-center gap-0.5')}
      >
        {button('bold', Bold, t('toolbar.bold'), state.bold, () => run((c) => c.toggleBold()))}
        {button('italic', Italic, t('toolbar.italic'), state.italic, () =>
          run((c) => c.toggleItalic()),
        )}
        {button('strike', Strikethrough, t('toolbar.strike'), state.strike, () =>
          run((c) => c.toggleStrike()),
        )}
        {button('code', Code, t('toolbar.code'), state.code, () => run((c) => c.toggleCode()))}
        {button('link', Link2, t('toolbar.link'), state.link, () => onLinkModeChange?.(true))}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        {button(
          'heading',
          headingIcon[state.heading],
          state.heading
            ? t('toolbar.headingLevel', { level: state.heading })
            : t('toolbar.heading'),
          state.heading > 0,
          () =>
            run((c) => (nextLevel === 0 ? c.setParagraph() : c.setHeading({ level: nextLevel }))),
        )}
        {button('bulletList', List, t('toolbar.bulletList'), state.bulletList, () =>
          run((c) => c.toggleBulletList()),
        )}
        {button('taskList', ListChecks, t('toolbar.taskList'), state.taskList, () =>
          run((c) => c.toggleTaskList()),
        )}
      </Toolbar>
    </div>
  );
}

interface LinkFieldProps {
  editor: Editor;
  href: string | null;
  onDone: () => void;
  isTooltipOpen: boolean | undefined;
  autoFocus: boolean;
}

/** The inline link address field: Enter applies, Esc cancels, both return to the text. */
function LinkField({ editor, href, onDone, isTooltipOpen, autoFocus }: LinkFieldProps) {
  const { t } = useTranslation('editor');
  const [text, setText] = useState(href ?? '');
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const tooltip = isTooltipOpen === undefined ? {} : { isTooltipOpen };

  const apply = () => {
    if (!text.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onDone();
      return;
    }
    const next = normalizeHref(text);
    if (!next) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: next }).run();
    onDone();
  };

  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onDone();
  };

  return (
    <div className="flex items-center gap-0.5">
      <Input
        autoFocus={autoFocus}
        onFocus={(event) => event.currentTarget.select()}
        aria-label={t('link.label')}
        placeholder={t('link.placeholder')}
        value={text}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          apply();
        }}
        className={cn('h-control-sm w-56 px-2 text-sm', invalid && 'border-border-danger')}
      />
      {invalid && (
        <span id={errorId} role="alert" className="sr-only">
          {t('link.invalid')}
        </span>
      )}
      <IconButton
        size="sm"
        icon={Check}
        aria-label={t('link.apply')}
        shortcut="Enter"
        onPress={apply}
        {...tooltip}
      />
      {href && (
        <>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={t('link.open')}
            title={t('link.open')}
            className="inline-flex size-control-sm items-center justify-center rounded-sm text-text-secondary hover:bg-bg-subtle hover:text-text"
          >
            <ExternalLink className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </a>
          <IconButton
            size="sm"
            icon={Unlink}
            aria-label={t('link.remove')}
            onPress={remove}
            {...tooltip}
          />
        </>
      )}
    </div>
  );
}
