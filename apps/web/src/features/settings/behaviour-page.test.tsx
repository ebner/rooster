import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { completeHideUntilReload } from '../list/hide-delay';
import { fixtureMe } from '../shell/fixtures';
import {
  BehaviourPage,
  type BehaviourSettings,
  hideDelayValues,
  shownDefaultOrg,
} from './behaviour-page';

const base: BehaviourSettings = {
  parseTitleDates: true,
  completeHideMs: 1500,
  swipeLeft: 'date',
  swipeRight: 'complete',
};

function renderPage(
  value: Partial<BehaviourSettings> = {},
  orgs: readonly (typeof fixtureMe.orgs)[number][] | undefined = undefined,
) {
  const onChange = vi.fn();
  render(<BehaviourPage value={{ ...base, ...value }} onChange={onChange} orgs={orgs} />);
  return onChange;
}

const [personal, company] = fixtureMe.orgs as [
  (typeof fixtureMe.orgs)[number],
  (typeof fixtureMe.orgs)[number],
];

describe('Settings → Behaviour (FR-SET-2)', () => {
  test('Recognise dates in task names saves prefs.parseTitleDates', () => {
    const onChange = renderPage();
    const toggle = screen.getByRole('switch', { name: /Recognise dates in task names/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ parseTitleDates: false });
  });

  test('Hide completed tasks after offers 1.5 s, 3 s and Until reload', () => {
    const onChange = renderPage();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      '1.5 s',
      '3 s',
      'Until reload',
    ]);
    expect((screen.getByRole('radio', { name: '1.5 s' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Until reload' }));
    expect(onChange).toHaveBeenCalledWith({ completeHideMs: completeHideUntilReload });
    fireEvent.click(screen.getByRole('radio', { name: '3 s' }));
    expect(onChange).toHaveBeenCalledWith({ completeHideMs: 3000 });
  });

  test('Until reload shows as selected for the stored maximum', () => {
    renderPage({ completeHideMs: completeHideUntilReload });
    expect((screen.getByRole('radio', { name: 'Until reload' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  test('a value set through the API outside the choices is kept as a choice', () => {
    expect(hideDelayValues(1500)).toEqual([1500, 3000, 10_000]);
    expect(hideDelayValues(5000)).toEqual([1500, 3000, 5000, 10_000]);
    expect(hideDelayValues(0)).toEqual([0, 1500, 3000, 10_000]);
    renderPage({ completeHideMs: 5000 });
    expect((screen.getByRole('radio', { name: '5 s' }) as HTMLInputElement).checked).toBe(true);
  });

  test('the swipe actions stay', () => {
    renderPage();
    expect(screen.getByText('Swipe actions')).toBeTruthy();
  });
});

describe('Settings → Behaviour: All organisations (ADR 0073 A4, A6)', () => {
  test('left out with a single org', () => {
    renderPage({}, [personal]);
    expect(screen.queryByText('Default organisation')).toBeNull();
    expect(screen.queryByText('Open rooster on')).toBeNull();
  });

  test('Default organisation shows Personal by default and saves an org', async () => {
    const onChange = renderPage({ defaultOrgId: null, startPage: 'last' }, fixtureMe.orgs);
    const field = screen.getByRole('button', { name: /Default organisation/ });
    expect(field.textContent).toContain('Personal');
    fireEvent.click(field);
    fireEvent.click(await screen.findByRole('option', { name: company.name }));
    expect(onChange).toHaveBeenCalledWith({ defaultOrgId: company.id });
  });

  test('choosing Personal stores null (the default)', async () => {
    const onChange = renderPage({ defaultOrgId: company.id }, fixtureMe.orgs);
    fireEvent.click(screen.getByRole('button', { name: /Default organisation/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Personal' }));
    expect(onChange).toHaveBeenCalledWith({ defaultOrgId: null });
  });

  test('an org the user left shows as Personal', () => {
    expect(shownDefaultOrg(fixtureMe.orgs, 'gone')?.id).toBe(personal.id);
    expect(shownDefaultOrg(fixtureMe.orgs, company.id)?.id).toBe(company.id);
    expect(shownDefaultOrg(fixtureMe.orgs, null)?.id).toBe(personal.id);
  });

  test('Open rooster on: the last view or All organisations · Today', () => {
    const onChange = renderPage({ startPage: 'last' }, fixtureMe.orgs);
    expect((screen.getByRole('radio', { name: 'The last view' }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'All organisations · Today' }));
    expect(onChange).toHaveBeenCalledWith({ startPage: 'all-today' });
  });
});
