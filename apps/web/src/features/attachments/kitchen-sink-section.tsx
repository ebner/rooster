import type { Attachment } from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../../lib/format';
import { Button } from '../../ui/button';
import { Group, Section } from '../dev-ui/layout';
import { AttachmentsView, type AttachmentsViewProps } from './attachments-view';
import { DropOverlayPreview } from './drop-overlay';
import {
  fixtureAttachments,
  fixtureImageSrc,
  fixtureNames,
  fixtureOtherUserId,
  fixtureUploads,
  fixtureUserId,
} from './fixtures';
import { Lightbox } from './lightbox';
import { isRasterImage } from './model';

const noop = () => {};

/** `/_dev/ui` (P10, WP 10.2): the pane's attachments in every state, the drop overlay, the lightbox. */
export function AttachmentsKitchenSection() {
  const { t, i18n } = useTranslation('attachments');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const prefs: DisplayPrefs = {
    locale,
    timezone: 'Europe/Stockholm',
    dateFormat: locale === 'sv' ? 'd MMM' : 'MMM d',
    timeFormat: '24h',
  };
  const now = useMemo(() => Date.now(), []);
  const [live, setLive] = useState<Attachment[]>(fixtureAttachments);
  const images = live.filter(isRasterImage);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [staticIndex, setStaticIndex] = useState(0);

  const common: Omit<AttachmentsViewProps, 'attachments' | 'uploads' | 'online'> = {
    userId: fixtureUserId,
    assigneeId: null,
    nameOf: (id) => fixtureNames[id],
    prefs,
    now,
    maxAttachments: 100,
    thumbSrc: fixtureImageSrc,
    downloadHref: () => '#',
    onPick: noop,
    onOpenImage: (image) => setLightbox(images.findIndex((i) => i.id === image.id)),
    onDelete: async (a) => setLive((all) => all.filter((x) => x.id !== a.id)),
    onRetry: noop,
    onDismiss: noop,
  };

  return (
    <Section id="attachments" title={t('dev.section')}>
      <Group title={t('dev.mixed')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView {...common} attachments={live} uploads={[]} online />
        </div>
      </Group>
      <Group title={t('dev.empty')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView {...common} attachments={[]} uploads={[]} online />
        </div>
      </Group>
      <Group title={t('dev.uploads')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView {...common} attachments={[]} uploads={fixtureUploads} online />
        </div>
      </Group>
      <Group title={t('dev.offline')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView
            {...common}
            attachments={fixtureAttachments.slice(4, 6)}
            uploads={[]}
            online={false}
          />
        </div>
      </Group>
      <Group title={t('dev.confirm')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView
            {...common}
            attachments={fixtureAttachments.slice(0, 2)}
            uploads={[]}
            online
            initialConfirmId={fixtureAttachments[0]?.id}
          />
        </div>
      </Group>
      <Group title={t('dev.readOnly')} className="block">
        <div className="max-w-pane-max">
          <AttachmentsView
            {...common}
            attachments={fixtureAttachments.filter((a) => a.uploaderId === fixtureOtherUserId)}
            uploads={[]}
            online
          />
        </div>
      </Group>
      <Group title={t('dev.drop')} className="block">
        <div className="max-w-pane-max">
          <DropOverlayPreview />
        </div>
      </Group>
      <Group title={t('dev.lightbox')} className="block">
        <div className="flex max-w-pane-max flex-col gap-3">
          <Lightbox
            images={images}
            index={Math.min(staticIndex, images.length - 1)}
            onIndexChange={setStaticIndex}
            onClose={noop}
            src={fixtureImageSrc}
            downloadHref={() => '#'}
            isStatic
          />
          <div>
            <Button onPress={() => setLightbox(0)}>{t('dev.openLightbox')}</Button>
          </div>
        </div>
      </Group>
      {lightbox !== null && lightbox >= 0 && (
        <Lightbox
          images={images}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          src={fixtureImageSrc}
          downloadHref={() => '#'}
        />
      )}
    </Section>
  );
}
