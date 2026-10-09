import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Logo, LogoMark } from '../../ui/logo';
import { Group, Section, Specimen } from './layout';

const markSizes = [16, 24, 48, 96] as const;
const appIcons = ['icon-192.png', 'maskable-512.png', 'apple-touch-icon-180.png'] as const;

/** 03 §2.10: the mark, the logo, the draw-in and the generated app icons. */
export function BrandSection() {
  const { t } = useTranslation('dev');
  const [run, setRun] = useState(0);
  return (
    <Section id="brand" title={t('section.brand')}>
      <Group title={t('brand.marks')}>
        {markSizes.map((size) => (
          <Specimen key={size} label={t('brand.size', { size })}>
            <LogoMark size={size} />
          </Specimen>
        ))}
        <Specimen label={t('brand.inverse')}>
          <span className="rounded-md bg-bg-inverse p-2">
            <LogoMark size={48} tone="inverse" />
          </span>
        </Specimen>
        <Specimen label={t('brand.muted')}>
          <LogoMark size={96} tone="muted" />
        </Specimen>
      </Group>
      <Group title={t('brand.logos')}>
        <Specimen label={t('brand.row')}>
          <Logo />
        </Specimen>
        <Specimen label={t('brand.page')}>
          <Logo size={32} />
        </Specimen>
        <Specimen label={t('brand.stack')}>
          <Logo layout="stack" size={64} />
        </Specimen>
      </Group>
      <Group title={t('brand.drawIn')}>
        <Specimen label={t('brand.drawInHint')}>
          <span className="flex items-center gap-6">
            <Logo key={run} layout="stack" size={64} animated="always" />
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              onPress={() => setRun((n) => n + 1)}
            >
              {t('brand.replay')}
            </Button>
          </span>
        </Specimen>
      </Group>
      <Group title={t('brand.appIcons')}>
        {appIcons.map((file) => (
          <Specimen key={file} label={file}>
            <img src={`/icons/${file}`} alt="" className="size-16" />
          </Specimen>
        ))}
      </Group>
    </Section>
  );
}
