import type { Tag } from '@rooster/core/schemas';
import { tagColorNames } from '@rooster/tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { Button } from '../../ui/button';
import { Group, Section } from '../dev-ui/layout';
import { TagDot } from './tag-dot';
import { TagFilterButton } from './tag-filter';
import { TagPicker } from './tag-picker';
import { TagsSection } from './tags-section';

const fixtureOrg = '01900000-0000-7000-8000-0000000000cc';

const sampleTags: Tag[] = ['urgent', 'mail', 'home', 'finance'].map((name, i) => ({
  id: `01900000-0000-7000-8000-00000000000${i}`,
  orgId: fixtureOrg,
  name,
  color: tagColorNames[(i * 3) % tagColorNames.length] ?? 'gray',
  createdAt: 0,
}));

function PickerDemo() {
  const { t } = useTranslation('tags');
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState<string[]>([sampleTags[0]?.id ?? '']);
  return (
    <span ref={anchor} className="inline-flex">
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        {t('picker.placeholder')}
      </Button>
      {open && anchor.current && (
        <TagPicker
          anchor={anchor.current}
          tags={sampleTags}
          applied={applied}
          label={t('picker.list')}
          onToggle={(id) =>
            setApplied((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
          }
          onCreate={() => undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

/** Kitchen-sink entry for WP 3.5: dots, the picker, the header filter and Settings → Tags. */
export function TagsKitchenSection() {
  const { t } = useTranslation('tags');
  const setup = useMemo(
    () => ({
      transport: createFixtureTransport({
        userId: '01900000-0000-7000-8000-000000000001',
        tags: sampleTags.map((tag) => ({ name: tag.name, color: tag.color })),
      }),
      queryClient: new QueryClient(),
    }),
    [],
  );
  const [tags, setTags] = useState(sampleTags);
  return (
    <Section id="tags" title={t('settings.title')}>
      <Group title={t('picker.list')}>
        {tagColorNames.map((color) => (
          <TagDot key={color} color={color} className="size-3" />
        ))}
        <PickerDemo />
        <QueryClientProvider client={setup.queryClient}>
          <ListTransportContext.Provider value={setup.transport}>
            <TagFilterButton orgId={fixtureOrg} />
          </ListTransportContext.Provider>
        </QueryClientProvider>
      </Group>
      <Group title={t('settings.title')} className="block">
        <TagsSection
          tags={tags}
          onRename={(id, name) =>
            setTags((all) => all.map((x) => (x.id === id ? { ...x, name } : x)))
          }
          onRecolor={(id, color) =>
            setTags((all) => all.map((x) => (x.id === id ? { ...x, color } : x)))
          }
          onMerge={(id) => setTags((all) => all.filter((x) => x.id !== id))}
          onDelete={(id) => setTags((all) => all.filter((x) => x.id !== id))}
        />
      </Group>
    </Section>
  );
}
