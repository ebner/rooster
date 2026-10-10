import { dueInstant } from '@rooster/core/dates';
import { isLocale, type Locale } from '@rooster/i18n/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { popoverSurface } from '../../ui/popover';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { DateCell } from './date-cell';
import { DateLabel } from './date-label';
import { DatePanel, datePopoverClass } from './date-popover';
import {
  sampleDateContext,
  sampleDue,
  sampleOwner,
  sampleReminder,
  sampleToday,
  sampleZone,
} from './fixtures';
import { QuickDateSheet } from './quick-date-sheet';
import { ReminderChips, useReminderViews } from './reminder-chips';
import { ReminderSection } from './reminder-section';
import { RepeatSection } from './repeat-section';
import { type DueValue, noDue, type ViewerDateContext } from './types';

const due = sampleDue;

const labelSamples = [
  ['overdue', due('2026-10-03')],
  ['overdueTime', due(sampleToday, '09:00')],
  ['today', due(sampleToday)],
  ['todayTime', due(sampleToday, '14:00')],
  ['tomorrow', due('2026-10-09')],
  ['thisWeek', due('2026-10-12')],
  ['later', due('2026-10-24')],
  ['nextYear', due('2027-01-15')],
  ['done', due('2026-10-03')],
  ['range', due('2026-10-12', null, '2026-10-10')],
] as const;

function CellSample({
  label,
  initial,
  ...props
}: {
  label: string;
  initial: DueValue;
  ctx: ViewerDateContext;
  rowHovered?: boolean;
  isReadOnly?: boolean;
  'data-force'?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Specimen label={label}>
      <div className="group/row flex h-row items-center rounded-sm border border-border bg-bg-app">
        <DateCell {...props} value={value} onChange={(next) => setValue(next ?? noDue)} />
      </div>
    </Specimen>
  );
}

/** Kitchen-sink entry for WP 2.5: labels in every due state, the cell, and the picker. */
export function DatesSection() {
  const { t, i18n } = useTranslation('dates');
  const locale: Locale = isLocale(i18n.language) ? i18n.language : 'en';
  const ctx = sampleDateContext(locale);
  const noop = () => {};
  return (
    <Section id="dates" title={t('dev.section')}>
      <Group title={t('dev.labels')}>
        {labelSamples.map(([state, value]) => (
          <Specimen key={state} label={t(`dev.state.${state}`)}>
            <DateLabel value={value} ctx={ctx} completed={state === 'done'} />
          </Specimen>
        ))}
      </Group>
      <Group title={t('dev.cells')}>
        <CellSample label={t('dev.state.empty')} initial={noDue} ctx={ctx} />
        <CellSample label={t('dev.state.emptyRowHover')} initial={noDue} ctx={ctx} rowHovered />
        <CellSample label={t('dev.state.filled')} initial={due('2026-10-09')} ctx={ctx} />
        <CellSample
          label={t('dev.state.focused')}
          initial={due('2026-10-03')}
          ctx={ctx}
          data-force="focus"
        />
        <CellSample
          label={t('dev.state.readOnly')}
          initial={due('2026-10-12', '14:00')}
          ctx={ctx}
          isReadOnly
        />
        <CellSample label={t('dev.live')} initial={due(sampleToday)} ctx={ctx} />
        <CellSample
          label={t('dev.state.range')}
          initial={due('2026-10-12', null, '2026-10-10')}
          ctx={ctx}
        />
      </Group>
      <Group title={t('dev.popover')}>
        <Specimen label={t('dev.english')}>
          <div lang="en" className={cn(popoverSurface, datePopoverClass)}>
            <DatePanel
              value={due('2026-10-12')}
              ctx={sampleDateContext('en')}
              onCommit={noop}
              onCancel={noop}
              autoFocus={false}
              defaultText="fri"
            />
          </div>
        </Specimen>
        <Specimen label={t('dev.swedish')}>
          <div lang="sv" className={cn(popoverSurface, datePopoverClass)}>
            <DatePanel
              value={due('2026-10-12', '14:00')}
              ctx={sampleDateContext('sv')}
              onCommit={noop}
              onCancel={noop}
              autoFocus={false}
            />
          </div>
        </Specimen>
      </Group>
      <RepeatReminderGroup locale={locale} />
      <Group title={t('dev.range')}>
        {rangeSamples.map(({ id, locale: lang, value, text, rangeMode }) => (
          <Specimen
            key={`${id}-${lang}`}
            label={`${t(`dev.state.${id}`)} · ${t(`dev.${lang === 'en' ? 'english' : 'swedish'}`)}`}
          >
            <div lang={lang} className={cn(popoverSurface, datePopoverClass)}>
              <DatePanel
                value={value}
                ctx={sampleDateContext(lang)}
                onCommit={noop}
                onCancel={noop}
                autoFocus={false}
                defaultText={text}
                defaultRangeMode={rangeMode}
              />
            </div>
          </Specimen>
        ))}
      </Group>
    </Section>
  );
}

interface RangeSample {
  id: 'rangeSet' | 'rangePickStart' | 'rangeTyped';
  locale: Locale;
  value: DueValue;
  text: string;
  rangeMode?: boolean;
}

const rangeSamples: readonly RangeSample[] = [
  { id: 'rangeSet', locale: 'en', value: due('2026-10-16', null, '2026-10-12'), text: '' },
  { id: 'rangePickStart', locale: 'en', value: due('2026-10-16'), text: '', rangeMode: true },
  { id: 'rangeTyped', locale: 'en', value: noDue, text: 'oct 10 - 12', rangeMode: true },
  { id: 'rangeSet', locale: 'sv', value: due('2026-11-02', '14:00', '2026-10-28'), text: '' },
];

const timedDue = sampleDue('2026-10-09', '14:00');
const allDayDue = sampleDue('2026-10-12');

/** P10: the picker's Repeat and Reminder sections, and the reminder chips in every state. */
function RepeatReminderGroup({ locale }: { locale: Locale }) {
  const { t } = useTranslation('dates');
  const ctx = sampleDateContext(locale);
  const noop = () => {};
  const reminders = [
    sampleReminder(1, { offsetMinutes: 60 }, timedDue),
    sampleReminder(2, { at: dueInstant('2026-10-09', '08:00', sampleZone) }, timedDue),
    sampleReminder(3, { offsetMinutes: 1440 }, timedDue, true),
  ];
  const dormant = [sampleReminder(4, { offsetMinutes: 15 }, null)];
  const full = [0, 15, 60, 120, 1440].map((offsetMinutes, i) =>
    sampleReminder(10 + i, { offsetMinutes }, allDayDue),
  );
  const chipViews = useReminderViews([...reminders, ...dormant], timedDue, ctx);
  const weekly = {
    ...sampleDue('2026-10-09'),
    recurrence: 'FREQ=WEEKLY;BYDAY=FR',
    recurrenceBasis: 'due' as const,
  };
  const reminderSection = (items: typeof reminders, value: DueValue, custom?: string) => (
    <div className={cn(popoverSurface, datePopoverClass)}>
      <ReminderSection
        items={items}
        due={value}
        owner={sampleOwner}
        ctx={ctx}
        onAdd={noop}
        onRemove={noop}
        defaultCustom={custom}
      />
    </div>
  );
  return (
    <Group title={t('dev.repeatReminders')}>
      <Specimen label={t('dev.state.repeatPreset')}>
        <div className={cn(popoverSurface, datePopoverClass)}>
          <DatePanel
            value={weekly}
            ctx={ctx}
            onCommit={noop}
            onCancel={noop}
            autoFocus={false}
            repeatable
            renderReminders={(slot) => (
              <ReminderSection
                items={reminders}
                due={slot.due}
                owner={sampleOwner}
                ctx={ctx}
                onAdd={noop}
                onRemove={noop}
              />
            )}
            showReminders
          />
        </div>
      </Specimen>
      <Specimen label={t('dev.state.repeatCustom')}>
        <div className={cn(popoverSurface, datePopoverClass)}>
          <RepeatSection
            choice={{
              kind: 'custom',
              rule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=4',
              basis: 'due',
            }}
            dueDate="2026-10-30"
            ctx={ctx}
            onChange={noop}
            defaultCustom
          />
        </div>
      </Specimen>
      <Specimen label={t('dev.state.repeatWeekdays')}>
        <div className={cn(popoverSurface, datePopoverClass)}>
          <RepeatSection
            choice={{ kind: 'custom', rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', basis: 'due' }}
            dueDate="2026-10-12"
            ctx={ctx}
            onChange={noop}
            defaultCustom
          />
        </div>
      </Specimen>
      <Specimen label={t('dev.state.remindersTimed')}>
        {reminderSection(reminders, timedDue, '2h')}
      </Specimen>
      <Specimen label={t('dev.state.remindersNoDate')}>
        {reminderSection(dormant, noDue, 'fri 14:00')}
      </Specimen>
      <Specimen label={t('dev.state.remindersFull')}>{reminderSection(full, allDayDue)}</Specimen>
      <Specimen label={t('dev.state.sheetRepeat')}>
        <QuickDateSheet
          isOpen
          isStatic
          onOpenChange={noop}
          value={weekly}
          ctx={ctx}
          onCommit={noop}
          repeatable
          renderReminders={(slot) => (
            <ReminderSection
              items={reminders}
              due={slot.due}
              owner={sampleOwner}
              ctx={ctx}
              onAdd={noop}
              onRemove={noop}
            />
          )}
        />
      </Specimen>
      <Specimen label={t('dev.state.reminderChips')}>
        <ReminderChips views={chipViews} ctx={ctx} onRemove={noop} data-force="focus" />
      </Specimen>
    </Group>
  );
}
