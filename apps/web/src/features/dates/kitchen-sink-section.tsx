import { isLocale, type Locale } from '@rooster/i18n';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { popoverSurface } from '../../ui/popover';
import { Group, Section, Specimen } from '../dev-ui/layout';
import { DateCell } from './date-cell';
import { DateLabel } from './date-label';
import { DatePanel, datePopoverClass } from './date-popover';
import { sampleDateContext, sampleDue, sampleToday } from './fixtures';
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
