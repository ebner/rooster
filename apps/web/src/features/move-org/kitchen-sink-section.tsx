import type { Group, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { bottomSheetSurface } from '../../ui/bottom-sheet';
import { popoverSurface } from '../../ui/popover';
import { Section, Specimen, Group as SpecimenGroup } from '../dev-ui/layout';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import {
  MoveOrgPanel,
  MoveOrgSheetBody,
  type MoveOrgStatus,
  type MoveOrgStep,
  type MoveOrgViewProps,
} from './move-org-picker';

const noop = () => {};
const orgs: readonly Org[] = fixtureMe.orgs;
const target = orgs[1] as Org;

const groups: Group[] = [
  ['01930000-0000-7000-8000-0000000000b1', 'inbox', 'Inbox'],
  ['01930000-0000-7000-8000-0000000000b2', 'normal', 'This week'],
  ['01930000-0000-7000-8000-0000000000b3', 'normal', 'Q4 launch'],
  ['01930000-0000-7000-8000-0000000000b4', 'normal', 'Someday'],
].map(([id, kind, name], i) => ({
  id: id as string,
  orgId: target.id,
  kind: kind as Group['kind'],
  name: name as string,
  position: `a${i}`,
  collapsed: false,
}));

const preview: TaskMoveToOrgPreview = {
  tasks: 1,
  subtasks: 2,
  comments: 3,
  attachments: 2,
  exposes: true,
  newTags: [],
  reassigned: 0,
};

function props(step: MoveOrgStep, status: MoveOrgStatus = 'ready'): MoveOrgViewProps {
  return {
    orgs,
    currentOrgId: fixtureIds.personalOrg,
    step,
    groups,
    preview,
    status,
    onPickOrg: noop,
    onPickGroup: noop,
    onBack: noop,
    onConfirm: noop,
    autoFocus: false,
  };
}

const popover = cn(popoverSurface, 'flex w-date-popover flex-col');
const sheet = cn(bottomSheetSurface, 'max-h-none w-date-popover pt-3');

/** ADR 0072 §22: every step of the move-to-organisation picker, as popover and as sheet. */
export function MoveOrgKitchenSection() {
  const { t } = useTranslation('list');
  const groupsStep: MoveOrgStep = { kind: 'groups', org: target };
  const confirmStep: MoveOrgStep = { kind: 'confirm', org: target, groupId: groups[1]?.id ?? '' };
  return (
    <Section id="moveOrg" title={t('moveToOrg.title')}>
      <SpecimenGroup title={t('moveToOrg.title')}>
        <Specimen label={t('dev.moveOrgOrgs')}>
          <div className={popover}>
            <MoveOrgPanel {...props({ kind: 'orgs' })} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgGroups')}>
          <div className={popover}>
            <MoveOrgPanel {...props(groupsStep)} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgChecking')}>
          <div className={popover}>
            <MoveOrgPanel {...props(groupsStep, 'checking')} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgOffline')}>
          <div className={popover}>
            <MoveOrgPanel {...props({ kind: 'orgs' }, 'offline')} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgConfirm')}>
          <div className={popover}>
            <MoveOrgPanel {...props(confirmStep)} />
          </div>
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup title={t('dev.moveOrgSheetOrgs')}>
        <Specimen label={t('dev.moveOrgSheetOrgs')}>
          <div className={sheet}>
            <MoveOrgSheetBody {...props({ kind: 'orgs' })} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgSheetGroups')}>
          <div className={sheet}>
            <MoveOrgSheetBody {...props(groupsStep)} />
          </div>
        </Specimen>
        <Specimen label={t('dev.moveOrgSheetConfirm')}>
          <div className={sheet}>
            <MoveOrgSheetBody {...props(confirmStep)} />
          </div>
        </Specimen>
      </SpecimenGroup>
    </Section>
  );
}
