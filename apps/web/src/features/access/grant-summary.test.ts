import { getI18n } from 'react-i18next';
import { describe, expect, test } from 'vitest';
import { fixtureIds } from '../shell/fixtures';
import { fixtureGrantOrgs as orgs } from './fixtures';
import { defaultTokenValue, setReadMode, setWriteMode, toggleScope } from './grant-model';
import { describeWhere } from './grant-summary';

const personal = fixtureIds.personalOrg;
const acme = fixtureIds.companyOrg;

describe('grant summary while a group list is still empty', () => {
  test('reading "only these groups" with none ticked says none are chosen yet (en and sv)', () => {
    const value = setReadMode(defaultTokenValue(orgs), orgs, personal, 'groups');
    expect(describeWhere(value, orgs, getI18n().getFixedT('en', 'settings'), 'en')).toBe(
      'Can read everything in Acme and only the groups you choose in Personal (none yet); can’t change anything.',
    );
    expect(describeWhere(value, orgs, getI18n().getFixedT('sv', 'settings'), 'sv')).toBe(
      'Kan läsa allt i Acme och bara de grupper du väljer i Personal (inga än); kan inte ändra något.',
    );
  });

  test('changing "only these groups" with none ticked says so too', () => {
    let value = toggleScope(defaultTokenValue(orgs), 'tasks:write', true, orgs);
    value = setWriteMode(value, orgs, acme, 'groups');
    // Writing starts in the personal Inbox (11 §3.1); Acme's list is still empty.
    expect(describeWhere(value, orgs, getI18n().getFixedT('en', 'settings'), 'en')).toBe(
      'Can read everything in Personal and Acme; can add and change tasks only in Personal › Inbox and the groups you choose in Acme (none yet).',
    );
  });
});
