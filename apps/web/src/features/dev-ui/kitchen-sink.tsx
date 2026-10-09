import {
  CircleAlert,
  Copy,
  FolderInput,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { Platform } from '../../lib/platform';
import { Avatar, type AvatarSize } from '../../ui/avatar';
import { Button, type ButtonVariant } from '../../ui/button';
import { Chip, ChipGroup, type ChipItem, tagColorNames } from '../../ui/chip';
import { IconButton } from '../../ui/icon-button';
import { TextField, type TextFieldProps } from '../../ui/input';
import { Kbd } from '../../ui/kbd';
import { LogoMark } from '../../ui/logo';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { Popover, PopoverTrigger, popoverSurface } from '../../ui/popover';
import { SkeletonRows } from '../../ui/skeleton';
import { SyncPill } from '../../ui/sync-pill';
import { TaskCheckbox } from '../../ui/task-checkbox';
import { ToastView, toast } from '../../ui/toast';
import { Tooltip, tooltipSurface } from '../../ui/tooltip';
import { AccessKitchenSection } from '../access/kitchen-sink-section';
import { CollabKitchenSection } from '../collab/kitchen-sink-section';
import { DatesSection } from '../dates/kitchen-sink-section';
import { EditorSection } from '../editor/kitchen-sink-section';
import { ListSection } from '../list/kitchen-sink-section';
import { LanguageSwitch } from '../locale/language-switch';
import { PaletteKitchenSection } from '../palette/kitchen-sink-section';
import { PaneSection } from '../pane/kitchen-sink-section';
import { PeopleKitchenSection } from '../people/kitchen-sink-section';
import { PwaKitchenSection } from '../pwa/kitchen-sink-section';
import { MobileKitchenSection } from '../shell/mobile-kitchen-section';
import { TagsKitchenSection } from '../tags/kitchen-sink-section';
import { ViewsKitchenSection } from '../views/kitchen-sink-section';
import { BrandSection } from './brand-section';
import { Group, Section, Specimen } from './layout';
import { Phase1Sections, phase1SectionIds } from './phase1-sections';

const sectionIds = [
  'foundations',
  'brand',
  'button',
  'iconButton',
  'input',
  'checkbox',
  'chip',
  'kbd',
  'tooltip',
  'popover',
  'menu',
  'toast',
  'avatar',
  'skeleton',
  'syncPill',
] as const;

type ForcedState = 'rest' | 'hover' | 'focus' | 'pressed';
const forcedStates: readonly ForcedState[] = ['rest', 'hover', 'focus', 'pressed'];
const forceProps = (state: ForcedState) => (state === 'rest' ? {} : { 'data-force': state });

const buttonVariantsShown = [
  'primary',
  'secondary',
  'ghost',
  'danger',
  'link',
] as const satisfies readonly ButtonVariant[];

/** Static class strings for the foundation swatches (Tailwind must see them literally). */
const surfaceSwatches = [
  ['bg-app', 'bg-bg-app'],
  ['bg-subtle', 'bg-bg-subtle'],
  ['bg-muted', 'bg-bg-muted'],
  ['bg-selected', 'bg-bg-selected'],
  ['bg-accent-subtle', 'bg-bg-accent-subtle'],
  ['bg-inbox', 'bg-bg-inbox'],
  ['bg-accent', 'bg-bg-accent'],
  ['bg-inverse', 'bg-bg-inverse'],
  ['check-done', 'bg-check-done'],
  ['border', 'bg-border'],
  ['border-strong', 'bg-border-strong'],
  ['border-focus', 'bg-border-focus'],
  ['overlay', 'bg-overlay'],
] as const;

const textSwatches = [
  ['text', 'text-text'],
  ['text-secondary', 'text-text-secondary'],
  ['text-muted', 'text-text-muted'],
  ['text-accent', 'text-text-accent'],
  ['text-danger', 'text-text-danger'],
  ['text-success', 'text-text-success'],
  ['text-warning', 'text-text-warning'],
] as const;

const dueDateSamples = [
  ['overdue', 'font-medium text-date-overdue'],
  ['today', 'font-medium text-date-today'],
  ['tomorrow', 'text-date-tomorrow'],
  ['thisWeek', 'text-date-this-week'],
  ['later', 'text-date-later'],
] as const;

/**
 * Below 4.5:1 by design (disabled controls; done-row dates, see 03 §2.3), so they are
 * shown as colour dots rather than text; axe would rightly flag them as body text.
 */
const decorativeTextSwatches = [
  ['text-disabled', 'bg-text-disabled'],
  ['date-done', 'bg-date-done'],
] as const;

const typeScale = [
  ['text-xs', 'text-xs'],
  ['text-sm', 'text-sm'],
  ['text-base', 'text-base'],
  ['text-md', 'text-md'],
  ['text-group', 'text-group'],
  ['text-lg', 'text-lg'],
  ['text-xl', 'text-xl'],
  ['text-2xl', 'text-2xl'],
] as const;

const tagKeys = [
  'mail',
  'work',
  'home',
  'urgent',
  'errand',
  'reading',
  'finance',
  'health',
  'travel',
  'ideas',
] as const;

const people = [
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e01', key: 'anna' },
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e02', key: 'jannik' },
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e03', key: 'markus' },
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e04', key: 'sara' },
  { id: '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e05', key: 'olof' },
] as const;
const avatarSizes: readonly AvatarSize[] = [16, 20, 24, 32, 40];

const shortcuts = [
  'Mod+K',
  'Mod+Enter',
  'Shift+Enter',
  'Alt+Shift+ArrowUp',
  'Escape',
  '?',
] as const;
const platforms: readonly (Platform | undefined)[] = [undefined, 'mac', 'other'];

function FoundationsSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="foundations" title={t('section.foundations')}>
      <Group title={t('group.colors')}>
        {surfaceSwatches.map(([name, className]) => (
          <Specimen key={name} label={name} className="font-mono">
            <span className={cn('size-10 rounded-sm border border-border', className)} />
          </Specimen>
        ))}
        {textSwatches.map(([name, className]) => (
          <Specimen key={name} label={name} className="font-mono">
            <span className={cn('font-sans text-lg', className)}>Aa</span>
          </Specimen>
        ))}
        {decorativeTextSwatches.map(([name, className]) => (
          <Specimen key={name} label={name} className="font-mono">
            <span className={cn('size-4 rounded-full', className)} />
          </Specimen>
        ))}
      </Group>
      <Group title={t('group.dueDates')}>
        {dueDateSamples.map(([state, className]) => (
          <Specimen key={state} label={state} className="font-mono">
            <span
              className={cn(
                'inline-flex items-center gap-1 font-sans text-sm tabular-nums',
                className,
              )}
            >
              {state === 'overdue' && (
                <CircleAlert className="size-3" strokeWidth={2} aria-hidden />
              )}
              {t(`sample.dates.${state}`)}
            </span>
          </Specimen>
        ))}
      </Group>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-text-muted">{t('group.typography')}</h3>
        <dl className="flex flex-col gap-2">
          {typeScale.map(([name, className]) => (
            <div key={name} className="flex items-baseline gap-4">
              <dt className="w-date-cell shrink-0 font-mono text-xs text-text-muted">{name}</dt>
              <dd className={cn('min-w-0 truncate', className)}>{t('sample.taskTitle')}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}

function ButtonSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="button" title={t('section.button')}>
      {buttonVariantsShown.map((variant) => (
        <Group key={variant} title={t(`variant.${variant}`)}>
          {forcedStates.map((state) => (
            <Specimen key={state} label={t(`state.${state}`)}>
              <Button variant={variant} {...forceProps(state)}>
                {t(`sample.${variant}`)}
              </Button>
            </Specimen>
          ))}
          <Specimen label={t('state.disabled')}>
            <Button variant={variant} isDisabled>
              {t(`sample.${variant}`)}
            </Button>
          </Specimen>
          <Specimen label={t('state.loading')}>
            <Button variant={variant} isLoading>
              {t(`sample.${variant}`)}
            </Button>
          </Specimen>
        </Group>
      ))}
      <Group title={t('group.sizes')}>
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <Specimen key={size} label={t(`size.${size}`)}>
            <Button size={size}>{t('sample.secondary')}</Button>
          </Specimen>
        ))}
      </Group>
      <Group title={t('group.withIcon')}>
        <Specimen label={t('variant.primary')}>
          <Button variant="primary" icon={Plus}>
            {t('sample.primary')}
          </Button>
        </Specimen>
        <Specimen label={t('variant.ghost')}>
          <Button variant="ghost" icon={SlidersHorizontal}>
            {t('sample.ghost')}
          </Button>
        </Specimen>
        <Specimen label={t('variant.danger')}>
          <Button variant="danger" icon={Trash2} size="sm">
            {t('sample.danger')}
          </Button>
        </Specimen>
      </Group>
    </Section>
  );
}

function IconButtonSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="iconButton" title={t('section.iconButton')}>
      <Group title={t('group.variants')}>
        {forcedStates.map((state) => (
          <Specimen key={state} label={t(`state.${state}`)}>
            <IconButton
              icon={MoreHorizontal}
              aria-label={t('sample.more')}
              {...forceProps(state)}
            />
          </Specimen>
        ))}
        <Specimen label={t('state.disabled')}>
          <IconButton icon={MoreHorizontal} aria-label={t('sample.more')} isDisabled />
        </Specimen>
        <Specimen label={t('state.loading')}>
          <IconButton icon={MoreHorizontal} aria-label={t('sample.more')} isLoading />
        </Specimen>
        <Specimen label={t('variant.secondary')}>
          <IconButton icon={Settings} aria-label={t('sample.settings')} variant="secondary" />
        </Specimen>
        <Specimen label={t('variant.primary')}>
          <IconButton
            icon={Plus}
            aria-label={t('sample.addTaskShortcut')}
            variant="primary"
            shortcut="Q"
          />
        </Specimen>
      </Group>
      <Group title={t('group.sizes')}>
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <Specimen key={size} label={t(`size.${size}`)}>
            <IconButton
              icon={Search}
              aria-label={t('sample.search')}
              shortcut="Mod+K"
              size={size}
            />
          </Specimen>
        ))}
      </Group>
    </Section>
  );
}

function InputSection() {
  const { t } = useTranslation('dev');
  const field = (extra: Partial<TextFieldProps> = {}) => (
    <TextField
      label={t('sample.inputLabel')}
      placeholder={t('sample.inputPlaceholder')}
      {...extra}
      className="w-full"
    />
  );
  return (
    <Section id="input" title={t('section.input')}>
      <div className="grid gap-x-6 gap-y-6 tablet:grid-cols-2 desktop:grid-cols-3">
        <Specimen label={t('state.rest')} className="[&>div]:w-full">
          {field({ description: t('sample.inputDescription') })}
        </Specimen>
        <Specimen label={t('state.hover')} className="[&>div]:w-full">
          {field({ 'data-force': 'hover' })}
        </Specimen>
        <Specimen label={t('state.focus')} className="[&>div]:w-full">
          {field({ 'data-force': 'focus' })}
        </Specimen>
        <Specimen label={t('state.filled')} className="[&>div]:w-full">
          {field({ defaultValue: t('sample.inputValue') })}
        </Specimen>
        <Specimen label={t('state.disabled')} className="[&>div]:w-full">
          {field({ isDisabled: true, defaultValue: t('sample.inputValue') })}
        </Specimen>
        <Specimen label={t('state.error')} className="[&>div]:w-full">
          {field({ errorMessage: t('sample.inputError') })}
        </Specimen>
        <Specimen label={t('state.inline')} className="[&>div]:w-full">
          <TextField
            label={t('sample.inlineLabel')}
            hideLabel
            variant="inline"
            defaultValue={t('sample.inlineValue')}
            className="w-full"
            inputClassName="text-group"
          />
        </Specimen>
      </div>
    </Section>
  );
}

function CheckboxSection() {
  const { t } = useTranslation('dev');
  const { t: tc } = useTranslation();
  const [done, setDone] = useState(false);
  const title = t('sample.taskTitle');
  const doneTitle = t('sample.doneTaskTitle');
  const label = (isDone: boolean, name: string) =>
    isDone ? tc('task.reopen', { title: name }) : tc('task.complete', { title: name });
  return (
    <Section id="checkbox" title={t('section.checkbox')}>
      <Group title={t('group.variants')}>
        {forcedStates
          .filter((state) => state !== 'pressed')
          .map((state) => (
            <Specimen key={state} label={t(`state.${state}`)}>
              <TaskCheckbox aria-label={label(false, title)} {...forceProps(state)} />
            </Specimen>
          ))}
        <Specimen label={t('state.done')}>
          <TaskCheckbox aria-label={label(true, doneTitle)} defaultSelected />
        </Specimen>
        <Specimen label={t('state.disabled')}>
          <TaskCheckbox aria-label={label(false, title)} isDisabled />
        </Specimen>
        <Specimen label={`${t('state.done')} · ${t('state.disabled')}`}>
          <TaskCheckbox aria-label={label(true, doneTitle)} isDisabled defaultSelected />
        </Specimen>
      </Group>
      <Group title={t('group.live')}>
        <div className="flex h-row w-full max-w-list-min items-center gap-2 rounded-sm px-3 hover:bg-bg-subtle">
          <TaskCheckbox aria-label={label(done, title)} isSelected={done} onChange={setDone} />
          <span className={cn('min-w-0 flex-1 truncate', done && 'text-text-muted line-through')}>
            {title}
          </span>
          <Chip color="blue">{t('sample.tags.mail')}</Chip>
          <span className="w-date-cell shrink-0 text-end text-sm font-medium text-date-today tabular-nums">
            {t('sample.dates.today')}
          </span>
        </div>
      </Group>
    </Section>
  );
}

function ChipSection() {
  const { t } = useTranslation('dev');
  const initial: ChipItem[] = tagKeys.slice(0, 4).map((key, index) => ({
    id: key,
    name: t(`sample.tags.${key}`),
    color: tagColorNames[(index * 3) % tagColorNames.length] ?? 'gray',
  }));
  const [removed, setRemoved] = useState<string[]>([]);
  return (
    <Section id="chip" title={t('section.chip')}>
      <Group title={t('group.tagPalette')} className="gap-x-4">
        {tagColorNames.map((color, index) => (
          <Specimen key={color} label={color} className="font-mono">
            <Chip color={color}>{t(`sample.tags.${tagKeys[index] ?? 'mail'}`)}</Chip>
          </Specimen>
        ))}
      </Group>
      <Group title={t('state.removable')}>
        <ChipGroup
          label={t('sample.tagsLabel')}
          items={initial.filter((item) => !removed.includes(item.id))}
          onRemove={(id) => setRemoved((r) => [...r, id])}
        />
        {removed.length > 0 && (
          <Button variant="link" size="sm" onPress={() => setRemoved([])}>
            {t('sample.restoreTags')}
          </Button>
        )}
      </Group>
    </Section>
  );
}

function KbdSection() {
  const { t } = useTranslation('dev');
  const platformLabel = (p: Platform | undefined) =>
    p === undefined ? t('state.auto') : p === 'mac' ? t('state.mac') : t('state.other');
  return (
    <Section id="kbd" title={t('section.kbd')}>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-text-muted">{t('group.platforms')}</h3>
        <div className="grid grid-cols-3 gap-x-6 gap-y-3 tablet:max-w-list-min">
          {platforms.map((p) => (
            <span key={p ?? 'auto'} className="text-xs text-text-muted">
              {platformLabel(p)}
            </span>
          ))}
          {shortcuts.map((shortcut) =>
            platforms.map((p) => (
              <span key={`${shortcut}-${p ?? 'auto'}`}>
                <Kbd shortcut={shortcut} {...(p ? { platform: p } : {})} />
              </span>
            )),
          )}
        </div>
      </div>
    </Section>
  );
}

function TooltipSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="tooltip" title={t('section.tooltip')}>
      <Group title={t('group.variants')} className="gap-x-12">
        <Specimen label={t('state.open')}>
          <div className="pt-10">
            <IconButton
              icon={Search}
              aria-label={t('sample.tooltipText')}
              shortcut="Mod+K"
              isTooltipOpen
            />
          </div>
        </Specimen>
        <Specimen label={t('group.preview')}>
          <div className="flex flex-col items-start gap-2 pt-10">
            <span className={tooltipSurface}>{t('sample.settings')}</span>
          </div>
        </Specimen>
        <Specimen label={t('group.live')}>
          <div className="pt-10">
            <Tooltip content={t('sample.settings')}>
              <Button variant="ghost" icon={Settings}>
                {t('sample.settings')}
              </Button>
            </Tooltip>
          </div>
        </Specimen>
      </Group>
    </Section>
  );
}

function PopoverSection() {
  const { t } = useTranslation('dev');
  const body = (
    <div className="flex w-date-popover max-w-full flex-col gap-1 p-2">
      <p className="text-sm font-semibold">{t('sample.popoverTitle')}</p>
      <p className="text-sm text-text-secondary">{t('sample.popoverBody')}</p>
    </div>
  );
  return (
    <Section id="popover" title={t('section.popover')}>
      <Group title={t('group.variants')}>
        <Specimen label={t('group.live')}>
          <PopoverTrigger>
            <Button>{t('sample.popoverTrigger')}</Button>
            <Popover aria-label={t('sample.popoverTitle')} placement="bottom start">
              {body}
            </Popover>
          </PopoverTrigger>
        </Specimen>
        <Specimen label={t('group.preview')} className="max-w-full">
          <div className={cn(popoverSurface, 'max-w-full')}>{body}</div>
        </Specimen>
      </Group>
    </Section>
  );
}

function TaskMenuItems() {
  const { t } = useTranslation('dev');
  return (
    <>
      <MenuItem id="rename" icon={Pencil} shortcut="F2">
        {t('sample.menuRename')}
      </MenuItem>
      <MenuItem id="duplicate" icon={Copy} shortcut="Mod+D">
        {t('sample.menuDuplicate')}
      </MenuItem>
      <MenuItem id="move" icon={FolderInput} shortcut="M">
        {t('sample.menuMove')}
      </MenuItem>
      <MenuItem id="copy-link" icon={Link2} isDisabled>
        {t('sample.menuCopyLink')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="delete" icon={Trash2} shortcut="Delete" tone="danger">
        {t('sample.menuDelete')}
      </MenuItem>
    </>
  );
}

function MenuSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="menu" title={t('section.menu')}>
      <Group title={t('group.variants')}>
        <Specimen label={t('group.live')}>
          <MenuTrigger>
            <IconButton
              icon={MoreHorizontal}
              aria-label={t('sample.menuTrigger')}
              variant="secondary"
            />
            <MenuPopover>
              <Menu aria-label={t('sample.menuLabel')}>
                <TaskMenuItems />
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        </Specimen>
        <Specimen label={t('state.open')}>
          <div className={popoverSurface}>
            <Menu aria-label={t('sample.menuLabel')} disabledKeys={['copy-link']}>
              <TaskMenuItems />
            </Menu>
          </div>
        </Specimen>
      </Group>
    </Section>
  );
}

function ToastSection() {
  const { t } = useTranslation('dev');
  const { t: tc } = useTranslation();
  const dangerMessage = t('sample.toastDanger', { title: t('sample.taskTitle') });
  return (
    <Section id="toast" title={t('section.toast')}>
      <Group title={t('group.live')}>
        <Button onPress={() => toast({ message: t('sample.toastInfo') })}>
          {t('sample.showToast')}
        </Button>
        <Button
          onPress={() =>
            toast({
              message: t('sample.toastAction'),
              action: {
                label: tc('action.undo'),
                onAction: () => toast({ message: t('sample.toastUndone') }),
              },
            })
          }
        >
          {t('sample.showToastAction')}
        </Button>
        <Button onPress={() => toast({ message: dangerMessage, tone: 'danger' })}>
          {t('sample.showToastDanger')}
        </Button>
      </Group>
      <Group title={t('group.preview')} className="flex-col">
        <Specimen label={t('variant.info')} className="w-full">
          <ToastView live={false} message={t('sample.toastInfo')} onDismiss={() => {}} />
        </Specimen>
        <Specimen label={t('variant.withAction')} className="w-full">
          <ToastView
            live={false}
            message={t('sample.toastAction')}
            action={{ label: tc('action.undo'), onAction: () => {} }}
            onDismiss={() => {}}
          />
        </Specimen>
        <Specimen label={t('variant.danger')} className="w-full">
          <ToastView live={false} tone="danger" message={dangerMessage} onDismiss={() => {}} />
        </Specimen>
      </Group>
    </Section>
  );
}

function AvatarSection() {
  const { t } = useTranslation('dev');
  const anna = people[0];
  return (
    <Section id="avatar" title={t('section.avatar')}>
      <Group title={t('group.sizes')}>
        {avatarSizes.map((size) => (
          <Specimen key={size} label={`${size}`}>
            <Avatar id={anna.id} name={t(`sample.people.${anna.key}`)} size={size} />
          </Specimen>
        ))}
      </Group>
      <Group title={t('group.people')}>
        {people.map((person) => (
          <Specimen key={person.id} label={t(`sample.people.${person.key}`)}>
            <Avatar id={person.id} name={t(`sample.people.${person.key}`)} size={32} />
          </Specimen>
        ))}
        <Specimen label={t('state.image')}>
          <Avatar id={anna.id} name={t('sample.people.anna')} src="/icons/icon-192.png" size={32} />
        </Specimen>
        <Specimen label={t('state.brokenImage')}>
          <Avatar
            id={people[1].id}
            name={t('sample.people.jannik')}
            src="/icons/missing-avatar.png"
            size={32}
          />
        </Specimen>
      </Group>
      <Group title={t('group.orgs')}>
        <Specimen label={t('sample.orgPersonal')}>
          <Avatar
            id="org-personal"
            name={t('sample.orgPersonal')}
            emoji="🏡"
            shape="square"
            size={24}
          />
        </Specimen>
        <Specimen label={t('sample.orgCompany')}>
          <Avatar id="org-northwind" name={t('sample.orgCompany')} shape="square" size={24} />
        </Specimen>
        <Specimen label="16">
          <Avatar id="org-northwind" name={t('sample.orgCompany')} shape="square" size={16} />
        </Specimen>
      </Group>
    </Section>
  );
}

function SkeletonSection() {
  const { t } = useTranslation('dev');
  return (
    <Section id="skeleton" title={t('section.skeleton')}>
      <div className="w-full max-w-list-min rounded-md border border-border py-1">
        <SkeletonRows count={3} />
      </div>
    </Section>
  );
}

function SyncPillSection() {
  const { t } = useTranslation('dev');
  const { t: tc } = useTranslation();
  return (
    <Section id="syncPill" title={t('section.syncPill')}>
      <Group title={t('group.variants')}>
        <Specimen label={t('state.offline')}>
          <SyncPill state="offline" />
        </Specimen>
        <Specimen label={t('state.pending')}>
          <SyncPill state="pending" pendingCount={3} />
        </Specimen>
        <Specimen label={t('state.syncing')}>
          <SyncPill state="syncing" />
        </Specimen>
        <Specimen label={t('state.error')}>
          <SyncPill state="error" onRetry={() => toast({ message: tc('sync.syncing') })} />
        </Specimen>
      </Group>
    </Section>
  );
}

/** `/_dev/ui`: every Coop component in every state (WP 0.5, AC-0.4; Phase 1 screens). */
export function KitchenSink() {
  const { t } = useTranslation('dev');
  return (
    <div className="min-h-dvh bg-bg-app">
      <header className="sticky top-0 z-(--z-sticky) border-b border-border bg-bg-app">
        <div className="mx-auto flex h-toolbar max-w-list-max items-center gap-3 px-3 tablet:px-6 desktop:px-8">
          <LogoMark />
          <span className="flex-1 truncate text-base font-semibold">{t('title')}</span>
          <LanguageSwitch />
        </div>
      </header>
      <main className="mx-auto flex max-w-list-max flex-col gap-16 px-3 pt-8 pb-16 tablet:px-6 desktop:px-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl">{t('title')}</h1>
          <p className="text-md text-text-secondary">{t('intro')}</p>
          <nav aria-label={t('contents')}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {[...sectionIds, ...phase1SectionIds].map((id) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="rounded-xs text-text-secondary underline-offset-2 hover:text-text hover:underline"
                  >
                    {t(`section.${id}`)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <FoundationsSection />
        <BrandSection />
        <ButtonSection />
        <IconButtonSection />
        <InputSection />
        <CheckboxSection />
        <ChipSection />
        <KbdSection />
        <TooltipSection />
        <PopoverSection />
        <MenuSection />
        <ToastSection />
        <AvatarSection />
        <SkeletonSection />
        <SyncPillSection />
        <PwaKitchenSection />
        <Phase1Sections />
        <DatesSection />
        <EditorSection />
        <ListSection />
        <PaneSection />
        <TagsKitchenSection />
        <MobileKitchenSection />
        <ViewsKitchenSection />
        <PaletteKitchenSection />
        <PeopleKitchenSection />
        <CollabKitchenSection />
        <AccessKitchenSection />
      </main>
    </div>
  );
}
