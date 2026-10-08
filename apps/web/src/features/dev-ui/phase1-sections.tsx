import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { isLocale } from '@rooster/i18n/core';
import type { TagColor } from '@rooster/tokens';
import { ListChecks, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AllowlistEntry,
  CurrentUser,
  Org,
  OrgInvite,
  OrgMember,
  UserSession,
} from '../../data/types';
import type { DisplayPrefs } from '../../lib/format';
import { Banner, type BannerTone } from '../../ui/banner';
import { ColorPicker } from '../../ui/color-picker';
import { EmojiPicker } from '../../ui/emoji-picker';
import { InlineTextField } from '../../ui/inline-text-field';
import { popoverSurface } from '../../ui/popover';
import { SegmentedControl } from '../../ui/segmented-control';
import { Select } from '../../ui/select';
import { toast } from '../../ui/toast';
import { AllowlistSection } from '../admin/allowlist-section';
import { BackupsSection } from '../admin/backups-section';
import { fixtureAdminUsers, fixtureAllowlist } from '../admin/fixtures';
import { UsersSection } from '../admin/users-section';
import { fixtureInvitePreviews, fixtureProviders } from '../auth/fixtures';
import { InvitePage } from '../auth/invite-page';
import { LoginPage, loginErrors } from '../auth/login-page';
import { NotInvitedPage } from '../auth/not-invited-page';
import { DangerZone } from '../org-settings/danger-zone';
import { fixtureInvites, fixtureMembers } from '../org-settings/fixtures';
import { GeneralSection } from '../org-settings/general-section';
import { OrgSettingsPage } from '../org-settings/org-settings-page';
import { fixtureSessions } from '../settings/fixtures';
import { ProfilePage } from '../settings/profile-page';
import { SecurityPage } from '../settings/security-page';
import { SettingsLayout } from '../settings/settings-layout';
import { TimezoneSelect } from '../settings/timezone-select';
import { ViewHeader } from '../shell/app-shell';
import { CreateOrgForm } from '../shell/create-org-form';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { Sidebar } from '../shell/sidebar';
import { SidebarItem } from '../shell/sidebar-item';
import { SidebarOrgSection } from '../shell/sidebar-org-section';
import { Group, Section, Specimen } from './layout';

export const phase1SectionIds = [
  'sidebar',
  'pickers',
  'formControls',
  'auth',
  'orgSettings',
  'userSettings',
  'admin',
] as const;

const noop = () => {};
const bannerTones: readonly BannerTone[] = ['info', 'success', 'warning', 'danger'];

function useSampleOrgs() {
  const [orgs, setOrgs] = useState<Org[]>(fixtureMe.orgs);
  return {
    orgs,
    reorder: (orgId: string, afterId: string | null) =>
      setOrgs((current) => {
        const moved = current.find((o) => o.id === orgId);
        if (!moved) return current;
        const rest = current.filter((o) => o.id !== orgId);
        rest.splice(afterId === null ? 0 : rest.findIndex((o) => o.id === afterId) + 1, 0, moved);
        return rest;
      }),
    toggle: (orgId: string) =>
      setOrgs((current) =>
        current.map((o) => (o.id === orgId ? { ...o, collapsed: !o.collapsed } : o)),
      ),
  };
}

function usePrefs(): DisplayPrefs {
  const { i18n } = useTranslation();
  return {
    locale: isLocale(i18n.language) ? i18n.language : 'en',
    timezone: 'Europe/Stockholm',
    dateFormat: 'MMM d',
    timeFormat: '24h',
  };
}

function SidebarSection() {
  const { t } = useTranslation('dev');
  const { t: ts } = useTranslation('shell');
  const { i18n } = useTranslation();
  const sample = useSampleOrgs();
  const [railOrgs] = useState(fixtureMe.orgs);
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const company = fixtureMe.orgs[1] as Org;
  const common = {
    user: fixtureMe.user,
    locale,
    onToggleCollapsed: noop,
    onCreateOrg: (input: { name: string }) => {
      toast({ message: ts('createOrg.created', { name: input.name }) });
    },
    onLocaleChange: noop,
    onSignOut: noop,
  };
  return (
    <Section id="sidebar" title={t('section.sidebar')}>
      <Group title={t('group.sidebarFrames')} className="items-stretch">
        <Specimen label={t('state.expanded')}>
          <div className="overflow-hidden rounded-lg border border-border">
            <Sidebar
              {...common}
              orgs={sample.orgs}
              active={{ orgId: fixtureIds.personalOrg, view: 'my' }}
              counts={{ [fixtureIds.companyOrg]: { my: 7 } }}
              collapsed={false}
              onReorder={(intent) => sample.reorder(intent.orgId, intent.afterId)}
              onToggleOrgCollapsed={(orgId) => sample.toggle(orgId)}
            />
          </div>
        </Specimen>
        <Specimen label={t('state.rail')}>
          <div className="overflow-hidden rounded-lg border border-border">
            <Sidebar
              {...common}
              orgs={railOrgs}
              active={{ orgId: fixtureIds.companyOrg, view: 'my' }}
              collapsed
              onReorder={noop}
              onToggleOrgCollapsed={noop}
            />
          </div>
        </Specimen>
      </Group>
      <Group title={t('group.sidebarItems')}>
        {(['rest', 'hover', 'focus'] as const).map((state) => (
          <Specimen key={state} label={t(`state.${state}`)} className="w-sidebar">
            <SidebarItem
              icon={ListChecks}
              label={ts('view.my')}
              {...(state === 'rest' ? {} : { 'data-force': state })}
            />
          </Specimen>
        ))}
        <Specimen label={t('state.active')} className="w-sidebar">
          <SidebarItem icon={ListChecks} label={ts('view.my')} isActive count={7} />
        </Specimen>
        <Specimen label={t('state.disabled')} className="w-sidebar">
          <SidebarItem icon={Search} label={ts('sidebar.search')} shortcut="Mod+K" isDisabled />
        </Specimen>
      </Group>
      <Group title={t('group.orgHeader')}>
        <DndContext>
          <SortableContext items={['header-rest', 'header-hover', 'header-collapsed']}>
            {(['rest', 'hover', 'collapsed'] as const).map((state) => (
              <Specimen
                key={state}
                label={t(`state.${state}`)}
                className="w-sidebar bg-bg-sidebar px-3 py-2"
              >
                <SidebarOrgSection
                  org={{ ...company, id: `header-${state}`, collapsed: state === 'collapsed' }}
                  activeView={null}
                  canMoveUp
                  canMoveDown={false}
                  onMove={noop}
                  onToggleCollapsed={noop}
                  {...(state === 'hover' ? { 'data-force': 'hover' } : {})}
                />
              </Specimen>
            ))}
          </SortableContext>
        </DndContext>
      </Group>
      <Group title={t('group.viewHeader')} className="flex-col items-stretch">
        <div className="w-full overflow-hidden rounded-lg border border-border">
          <ViewHeader title={ts('view.my')} context={company.name} />
        </div>
      </Group>
    </Section>
  );
}

function PickersSection() {
  const { t } = useTranslation('dev');
  const { t: ts } = useTranslation('shell');
  const [emoji, setEmoji] = useState<string | null>('🚀');
  const [color, setColor] = useState<TagColor>('blue');
  return (
    <Section id="pickers" title={t('section.pickers')}>
      <Group title={t('group.emoji')} className="items-start">
        <Specimen label={t('group.live')} className="w-date-popover">
          <EmojiPicker
            label={ts('createOrg.icon')}
            value={emoji}
            onChange={setEmoji}
            name="Northwind"
          />
        </Specimen>
        <Specimen label={t('state.initials')} className="w-date-popover">
          <EmojiPicker label={ts('createOrg.icon')} value={null} onChange={noop} name="Book club" />
        </Specimen>
        <Specimen label={t('state.disabled')} className="w-date-popover">
          <EmojiPicker
            label={ts('createOrg.icon')}
            value="🏡"
            onChange={noop}
            name="Personal"
            isDisabled
          />
        </Specimen>
      </Group>
      <Group title={t('group.color')}>
        <Specimen label={t('group.live')}>
          <ColorPicker label={ts('createOrg.color')} value={color} onChange={setColor} />
        </Specimen>
        <Specimen label={t('state.disabled')}>
          <ColorPicker label={ts('createOrg.color')} value="green" onChange={noop} isDisabled />
        </Specimen>
      </Group>
      <Group title={t('group.createOrg')} className="items-start">
        <Specimen label={t('state.open')}>
          <div className={popoverSurface}>
            <CreateOrgForm
              defaultColor="purple"
              onSubmit={noop}
              onCancel={noop}
              autoFocus={false}
            />
          </div>
        </Specimen>
        <Specimen label={t('state.error')}>
          <div className={popoverSurface}>
            <CreateOrgForm
              defaultColor="teal"
              onSubmit={noop}
              onCancel={noop}
              initialError={ts('createOrg.failed')}
              autoFocus={false}
            />
          </div>
        </Specimen>
      </Group>
    </Section>
  );
}

function FormControlsSection() {
  const { t } = useTranslation('dev');
  const [week, setWeek] = useState<'1' | '0'>('1');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [name, setName] = useState('Northwind');
  const [zone, setZone] = useState('Europe/Stockholm');
  const weekOptions = [
    { id: '1', label: t('sample.monday') },
    { id: '0', label: t('sample.sunday') },
  ] as const;
  const roleOptions = [
    { id: 'owner', label: t('sample.owner') },
    { id: 'member', label: t('sample.member') },
  ] as const;
  return (
    <Section id="formControls" title={t('section.formControls')}>
      <Group title={t('group.segmented')}>
        <Specimen label={t('state.rest')}>
          <SegmentedControl
            label={t('sample.weekStart')}
            options={weekOptions}
            value={week}
            onChange={setWeek}
          />
        </Specimen>
        <Specimen label={t('state.focus')}>
          <SegmentedControl
            label={t('sample.weekStart')}
            options={weekOptions}
            value="1"
            onChange={noop}
            data-force="focus"
          />
        </Specimen>
        <Specimen label={t('state.disabled')}>
          <SegmentedControl
            label={t('sample.weekStart')}
            options={weekOptions}
            value="0"
            onChange={noop}
            isDisabled
          />
        </Specimen>
      </Group>
      <Group title={t('group.select')}>
        {(['rest', 'hover', 'focus'] as const).map((state) => (
          <Specimen key={state} label={t(`state.${state}`)} className="w-label-col">
            <Select
              label={t('sample.role')}
              options={roleOptions}
              value={role}
              onChange={setRole}
              className="w-label-col"
              {...(state === 'rest' ? {} : { 'data-force': state })}
            />
          </Specimen>
        ))}
        <Specimen label={t('state.disabled')} className="w-label-col">
          <Select
            label={t('sample.role')}
            options={roleOptions}
            value="owner"
            onChange={noop}
            isDisabled
            className="w-label-col"
          />
        </Specimen>
        <Specimen label={t('group.timezone')} className="w-pane-min">
          <TimezoneSelect value={zone} onChange={setZone} className="w-full" />
        </Specimen>
      </Group>
      <Group title={t('group.inlineEdit')}>
        {(['rest', 'hover', 'focus'] as const).map((state) => (
          <Specimen key={state} label={t(`state.${state}`)}>
            <InlineTextField
              label={t('sample.orgName')}
              value={name}
              onCommit={setName}
              textClassName="text-xl"
              {...(state === 'rest' ? {} : { 'data-force': state })}
            />
          </Specimen>
        ))}
        <Specimen label={t('state.disabled')}>
          <InlineTextField
            label={t('sample.orgName')}
            value={name}
            onCommit={noop}
            isDisabled
            textClassName="text-xl"
          />
        </Specimen>
      </Group>
      <Group title={t('group.banner')} className="flex-col items-stretch">
        {bannerTones.map((tone) => (
          <Banner key={tone} tone={tone} title={t(`sample.banner.${tone}.title`)}>
            {t(`sample.banner.${tone}.body`)}
          </Banner>
        ))}
      </Group>
    </Section>
  );
}

function AuthSection() {
  const { t } = useTranslation('dev');
  const { t: ta } = useTranslation('auth');
  const preview = fixtureInvitePreviews.demo;
  const expired = fixtureInvitePreviews.expired;
  return (
    <Section id="auth" title={t('section.auth')}>
      <Group title={t('group.login')} className="items-start">
        <Specimen label={t('state.error')} className="w-pane">
          <LoginPage embedded providers={fixtureProviders} error="not_invited" onSignIn={noop} />
        </Specimen>
        <Specimen label={t('state.loading')} className="w-pane">
          <LoginPage
            embedded
            providers={fixtureProviders}
            pendingProviderId="google"
            onSignIn={noop}
          />
        </Specimen>
        <Specimen label={t('state.empty')} className="w-pane">
          <LoginPage embedded providers={[]} onSignIn={noop} />
        </Specimen>
      </Group>
      <Group title={t('group.loginErrors')} className="flex-col items-stretch">
        {loginErrors.map((error) => (
          <Banner key={error} tone="danger" title={ta(`login.error.${error}.title`)}>
            {ta(`login.error.${error}.body`)}
          </Banner>
        ))}
      </Group>
      <Group title={t('group.invite')} className="items-start">
        <Specimen label={t('state.signedOut')} className="w-pane">
          {preview && (
            <InvitePage
              embedded
              preview={preview}
              signedIn={false}
              providers={fixtureProviders}
              onAcceptAndSignIn={noop}
              onJoin={noop}
              homeHref="/"
            />
          )}
        </Specimen>
        <Specimen label={t('state.signedIn')} className="w-pane">
          {preview && (
            <InvitePage
              embedded
              preview={preview}
              signedIn
              providers={fixtureProviders}
              onAcceptAndSignIn={noop}
              onJoin={noop}
              homeHref="/"
            />
          )}
        </Specimen>
        <Specimen label={t('state.expired')} className="w-pane">
          {expired && (
            <InvitePage
              embedded
              preview={expired}
              signedIn={false}
              providers={fixtureProviders}
              onAcceptAndSignIn={noop}
              onJoin={noop}
              homeHref="/"
            />
          )}
        </Specimen>
        <Specimen label={t('group.notInvited')} className="w-pane">
          <NotInvitedPage embedded email="sam@example.org" loginHref="/login" />
        </Specimen>
        <Specimen label={t('group.linkBlocked')} className="w-pane">
          <NotInvitedPage embedded reason="account_link_blocked" loginHref="/login" />
        </Specimen>
      </Group>
    </Section>
  );
}

function OrgSettingsSection() {
  const { t } = useTranslation('dev');
  const prefs = usePrefs();
  const [company, setCompany] = useState(fixtureMe.orgs[1] as Org);
  const [members, setMembers] = useState<OrgMember[]>(fixtureMembers[fixtureIds.companyOrg] ?? []);
  const [invites, setInvites] = useState<OrgInvite[]>(fixtureInvites[fixtureIds.companyOrg] ?? []);
  const personal = fixtureMe.orgs[0] as Org;
  const club = fixtureMe.orgs[2] as Org;
  const now = Date.now();
  return (
    <Section id="orgSettings" title={t('section.orgSettings')}>
      <Group title={t('group.ownerView')} className="flex-col items-stretch">
        <OrgSettingsPage
          org={company}
          currentUserId={fixtureIds.jannik}
          members={members}
          invites={invites}
          prefs={prefs}
          now={now}
          onUpdateOrg={(patch) => setCompany((o) => ({ ...o, ...patch }))}
          onChangeRole={(userId, role) =>
            setMembers((list) => list.map((m) => (m.userId === userId ? { ...m, role } : m)))
          }
          onRemoveMember={(userId) => setMembers((list) => list.filter((m) => m.userId !== userId))}
          onCreateInvite={async (draft) => {
            const invite: OrgInvite = {
              id: `sample-${now}-${invites.length}`,
              kind: draft.kind,
              email: draft.kind === 'email' ? draft.email : null,
              role: draft.role,
              multiUse: draft.kind === 'link' && draft.multiUse,
              uses: 0,
              url: 'https://rooster.example.com/invite/demo',
              expiresAt: now + draft.expiresInDays * 86_400_000,
              createdAt: now,
            };
            setInvites((list) => [invite, ...list]);
            return { id: invite.id, kind: invite.kind, url: invite.url ?? '' };
          }}
          onRevokeInvite={(id) => setInvites((list) => list.filter((i) => i.id !== id))}
          onDeleteOrg={async () => {}}
          onLeaveOrg={async () => {}}
        />
      </Group>
      <Group title={t('group.personalView')} className="flex-col items-stretch">
        <GeneralSection org={personal} onUpdate={noop} />
        <DangerZone org={personal} isSoleOwner onDelete={async () => {}} onLeave={async () => {}} />
      </Group>
      <Group title={t('group.memberView')} className="flex-col items-stretch">
        <GeneralSection org={club} onUpdate={noop} />
        <DangerZone
          org={club}
          isSoleOwner={false}
          onDelete={async () => {}}
          onLeave={async () => {}}
        />
      </Group>
      <Group title={t('group.deleteConfirm')} className="flex-col items-stretch">
        <DangerZone
          org={company}
          isSoleOwner
          defaultExpanded="delete"
          onDelete={async () => {}}
          onLeave={async () => {}}
        />
      </Group>
    </Section>
  );
}

function UserSettingsSection() {
  const { t } = useTranslation('dev');
  const prefs = usePrefs();
  const [user, setUser] = useState<CurrentUser>(fixtureMe.user);
  const [sessions, setSessions] = useState<UserSession[]>(fixtureSessions);
  return (
    <Section id="userSettings" title={t('section.userSettings')}>
      <Group title={t('group.profile')} className="flex-col items-stretch">
        <SettingsLayout active="profile">
          <ProfilePage
            user={user}
            onChange={(patch) => setUser((u) => ({ ...u, ...patch }))}
            onLocaleChange={(locale) => setUser((u) => ({ ...u, locale }))}
          />
        </SettingsLayout>
      </Group>
      <Group title={t('group.security')} className="flex-col items-stretch">
        <SecurityPage
          sessions={sessions}
          prefs={prefs}
          now={Date.now()}
          pendingSessionId="session-laptop"
          onRevoke={(id) => setSessions((list) => list.filter((s) => s.id !== id))}
        />
      </Group>
    </Section>
  );
}

function AdminSection() {
  const { t } = useTranslation('dev');
  const prefs = usePrefs();
  const [entries, setEntries] = useState<AllowlistEntry[]>(fixtureAllowlist);
  const [users, setUsers] = useState(fixtureAdminUsers);
  const now = Date.now();
  return (
    <Section id="admin" title={t('section.admin')}>
      <AllowlistSection
        entries={entries}
        prefs={prefs}
        now={now}
        onAdd={async ({ kind, value }) =>
          setEntries((list) => [
            { id: `sample-${list.length}`, kind, value, createdAt: now },
            ...list,
          ])
        }
        onRemove={(id) => setEntries((list) => list.filter((e) => e.id !== id))}
      />
      <AllowlistSection
        entries={[]}
        prefs={prefs}
        now={now}
        onAdd={async () => {}}
        onRemove={noop}
      />
      <UsersSection
        users={users}
        currentUserId={fixtureIds.jannik}
        prefs={prefs}
        now={now}
        onSetDisabled={(userId, disabled) =>
          setUsers((list) =>
            list.map((u) => (u.id === userId ? { ...u, disabledAt: disabled ? now : null } : u)),
          )
        }
      />
      <BackupsSection
        backups={[
          {
            name: 'manual-2026-10-05T08-00-00-000Z.db',
            size: 1_482_752,
            createdAt: now - 3_600_000,
            kind: 'manual',
          },
          {
            name: 'rooster-2026-10-04T02-00-00-000Z.db',
            size: 1_437_184,
            createdAt: now - 86_400_000,
            kind: 'weekly',
          },
          {
            name: 'rooster-2026-10-03T02-00-00-000Z.db',
            size: 1_398_000,
            createdAt: now - 2 * 86_400_000,
            kind: 'daily',
          },
        ]}
        prefs={prefs}
        now={now}
        downloadUrl={() => '#'}
        onBackUpNow={noop}
      />
    </Section>
  );
}

/** Phase 1 components and screens, rendered from fixtures with local state. */
export function Phase1Sections() {
  return (
    <>
      <SidebarSection />
      <PickersSection />
      <FormControlsSection />
      <AuthSection />
      <OrgSettingsSection />
      <UserSettingsSection />
      <AdminSection />
    </>
  );
}
