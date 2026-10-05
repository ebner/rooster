import type { Tag } from '@rooster/core/schemas';
import { ListChecks, Search, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessoryBar } from '../../ui/accessory-bar';
import { BottomNav } from '../../ui/bottom-nav';
import { Fab } from '../../ui/fab';
import { MenuItem } from '../../ui/menu';
import { SwipeReveal, type SwipeRevealAction } from '../../ui/swipe-reveal';
import { SyncPill } from '../../ui/sync-pill';
import { sampleDateContext, sampleDue } from '../dates/fixtures';
import { QuickDateSheet } from '../dates/quick-date-sheet';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { GroupSheet } from '../list/group-sheet';
import { SheetHeader } from '../pane/sheet-header';
import { TagSheet } from '../tags/tag-sheet';
import { fixtureMe } from './fixtures';
import { MobileHeader, OrgSwitcherSheet } from './mobile-header';

const noop = () => undefined;

const sampleTags: Tag[] = [
  { id: 't1', orgId: 'o', name: 'mail', color: 'blue', createdAt: 0 },
  { id: 't2', orgId: 'o', name: 'personal', color: 'green', createdAt: 0 },
  { id: 't3', orgId: 'o', name: 'work', color: 'red', createdAt: 0 },
];

/** A phone-width frame so the specimens render at their real size. */
function Phone({ children }: { children: ReactNode }) {
  return (
    <div className="w-pane-overlay max-w-full overflow-hidden rounded-lg border border-border bg-bg-app">
      {children}
    </div>
  );
}

/** A swiped row: the reveal behind, the row pushed `share` of the way. */
function SwipeSpecimen({
  action,
  side,
  armed,
  label,
}: {
  action: SwipeRevealAction;
  side: 'start' | 'end';
  armed: boolean;
  label: string;
}) {
  const { t } = useTranslation('mobile');
  return (
    <div className="relative h-row-mobile w-pane-min max-w-full overflow-hidden rounded-sm">
      <SwipeReveal
        action={action}
        side={side}
        armed={armed}
        label={t(`swipe.${action}`)}
        className="absolute inset-0"
      />
      <div
        className={
          side === 'start'
            ? `absolute inset-y-0 end-0 flex items-center gap-3 rounded-sm bg-bg-app px-3 text-md ${armed ? 'start-1/2' : 'start-1/4'}`
            : `absolute inset-y-0 start-0 flex items-center gap-3 rounded-sm bg-bg-app px-3 text-md ${armed ? 'end-1/2' : 'end-1/4'}`
        }
      >
        <span className="size-checkbox shrink-0 rounded-full border-(length:--border-check) border-border-strong" />
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

/**
 * Kitchen-sink entry for WP 4.5–4.7: the phone header, view switcher, bottom nav, FAB,
 * swipe reveals, accessory bar, the detail sheet's header and every bottom sheet.
 */
export function MobileKitchenSection() {
  const { t, i18n } = useTranslation('mobile');
  const { t: tList } = useTranslation('list');
  const ctx = sampleDateContext(i18n.language === 'sv' ? 'sv' : 'en');
  const orgs = fixtureMe.orgs;
  const personal = orgs[0] ?? null;
  const groups = [
    { id: 'g1', name: 'Today' },
    { id: 'g2', name: 'Prio' },
    { id: 'g3', name: 'Upcoming' },
  ];
  const nav = (active: string, force?: string) => (
    <BottomNav
      label={t('nav.label')}
      {...(force ? { 'data-force': force } : {})}
      items={[
        {
          id: 'my',
          label: t('nav.myTasks'),
          icon: ListChecks,
          onPress: noop,
          isActive: active === 'my',
        },
        { id: 'search', label: t('nav.search'), icon: Search, isDisabled: true },
        {
          id: 'settings',
          label: t('nav.settings'),
          icon: Settings,
          onPress: noop,
          isActive: active === 'settings',
        },
      ]}
    />
  );

  return (
    <Section id="mobile" title={t('dev.section')}>
      <Group title={t('dev.header')}>
        <Phone>
          <MobileHeader
            isStatic
            title={t('nav.myTasks')}
            org={personal}
            onOpenOrgs={noop}
            syncPill={null}
            menu={<MenuItem onAction={noop}>{t('nav.settings')}</MenuItem>}
            views={[{ id: 'my', label: t('nav.myTasks'), href: '#mobile', isActive: true }]}
          />
        </Phone>
        <Phone>
          <MobileHeader
            isStatic
            title={t('nav.settings')}
            org={personal}
            onOpenOrgs={noop}
            syncPill={<SyncPill state="syncing" />}
            menu={<MenuItem onAction={noop}>{t('nav.settings')}</MenuItem>}
          />
        </Phone>
      </Group>
      <Group title={t('dev.bottomNav')}>
        <Phone>{nav('my')}</Phone>
        <Phone>{nav('settings', 'pressed')}</Phone>
      </Group>
      <Group title={t('dev.fab')}>
        <Specimen label="rest">
          <Fab isStatic aria-label={t('fab.label')} />
        </Specimen>
        <Specimen label="hover">
          <Fab isStatic aria-label={t('fab.label')} data-force="hover" />
        </Specimen>
        <Specimen label="pressed">
          <Fab isStatic aria-label={t('fab.label')} data-force="pressed" />
        </Specimen>
        <Specimen label="focus">
          <Fab isStatic aria-label={t('fab.label')} data-force="focus" />
        </Specimen>
      </Group>
      <Group title={t('dev.swipe')} className="flex-col">
        <SwipeSpecimen action="complete" side="start" armed={false} label="Book dentist" />
        <SwipeSpecimen action="complete" side="start" armed label="Book dentist" />
        <SwipeSpecimen action="date" side="end" armed label="Renew passport" />
        <SwipeSpecimen action="move" side="end" armed={false} label="Write Q4 plan" />
        <SwipeSpecimen action="delete" side="start" armed label="Old draft" />
      </Group>
      <Group title={t('dev.accessory')} className="flex-col">
        <Phone>
          <AccessoryBar
            isStatic
            groupLabel="Today"
            onDate={noop}
            onGroup={noop}
            onTag={noop}
            onNext={noop}
          />
        </Phone>
        <Phone>
          <AccessoryBar
            isStatic
            dateLabel="Tomorrow"
            groupLabel="Prio"
            onDate={noop}
            onGroup={noop}
            onTag={noop}
            onNext={noop}
          />
        </Phone>
      </Group>
      <Group title={t('dev.sheetHeader')}>
        <Phone>
          <SheetHeader
            onBack={noop}
            menu={<MenuItem onAction={noop}>{t('nav.settings')}</MenuItem>}
            surfaceRef={{ current: null }}
          />
        </Phone>
      </Group>
      <Group title={t('dev.sheets')}>
        <Phone>
          <QuickDateSheet
            isStatic
            isOpen
            onOpenChange={noop}
            value={sampleDue('2026-10-09')}
            ctx={ctx}
            onCommit={noop}
            subject="Book dentist"
          />
        </Phone>
        <Phone>
          <QuickDateSheet
            isStatic
            isOpen
            defaultPicking
            onOpenChange={noop}
            value={sampleDue('2026-10-09')}
            ctx={ctx}
            onCommit={noop}
          />
        </Phone>
        <Phone>
          <GroupSheet
            isStatic
            isOpen
            onOpenChange={noop}
            title={tList('bulk.moveTo')}
            groups={groups}
            current="g1"
            onPick={noop}
            subject={t('subject.tasks', { count: 3 })}
          />
        </Phone>
        <Phone>
          <TagSheet
            isStatic
            isOpen
            onOpenChange={noop}
            tags={sampleTags}
            applied={['t1']}
            onToggle={noop}
            onCreate={noop}
            subject="Reply to Anna"
          />
        </Phone>
        <Phone>
          <OrgSwitcherSheet
            isStatic
            isOpen
            onOpenChange={noop}
            orgs={orgs}
            activeOrgId={personal?.id}
            onSelect={noop}
            onCreateOrg={noop}
          />
        </Phone>
      </Group>
    </Section>
  );
}
