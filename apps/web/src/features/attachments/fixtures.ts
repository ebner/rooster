import type { Attachment } from '@rooster/core/schemas';
import { tagPalette } from '@rooster/tokens';
import type { PendingUpload } from './upload-store';

/** Kitchen-sink and test fixtures for the pane's attachments (P10). */
export const fixtureTaskId = '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d6a00';
export const fixtureUserId = '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e02';
export const fixtureOtherUserId = '0192f5d0-7a1e-7c3a-9f10-1a2b3c4d5e01';

const base = Date.UTC(2026, 9, 8, 9, 30);

function attachment(
  n: number,
  filename: string,
  mime: string,
  size: number,
  image: Attachment['image'] = null,
  uploaderId = fixtureUserId,
): Attachment {
  return {
    id: `0192f5d0-7a1e-7c3a-9f10-1a2b3c4d6b0${n}`,
    taskId: fixtureTaskId,
    filename,
    mime,
    size,
    uploaderId,
    image,
    createdAt: base + n * 60_000,
  };
}

export const fixtureAttachments: Attachment[] = [
  attachment(1, 'whiteboard.jpg', 'image/jpeg', 2_480_000, {
    width: 4032,
    height: 3024,
    thumb: true,
  }),
  attachment(2, 'floor-plan.png', 'image/png', 812_000, { width: 1600, height: 1200, thumb: true }),
  attachment(
    3,
    'sunset over the archipelago with a very long file name.webp',
    'image/webp',
    96_000,
    { width: 1200, height: 800, thumb: true },
    fixtureOtherUserId,
  ),
  attachment(4, 'huge-scan.tiff.png', 'image/png', 18_000_000, {
    width: 9000,
    height: 6000,
    thumb: false,
  }),
  attachment(5, 'Quarterly report Q3.pdf', 'application/pdf', 1_250_000),
  attachment(
    6,
    'budget-2027.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    48_500,
    null,
    fixtureOtherUserId,
  ),
  attachment(7, 'notes.txt', 'text/plain', 812),
  attachment(8, 'logo.svg', 'image/svg+xml', 4_100),
  attachment(9, 'photos.zip', 'application/zip', 124_000_000, null, fixtureOtherUserId),
];

export const fixtureNames: Record<string, string> = {
  [fixtureUserId]: 'Jannik Lunde',
  [fixtureOtherUserId]: 'Anna Lindqvist',
};

export const fixtureUploads: PendingUpload[] = [
  {
    id: 'u1',
    taskId: fixtureTaskId,
    name: 'site-visit.mov',
    size: 48_000_000,
    progress: 0.42,
    status: 'uploading',
  },
  {
    id: 'u2',
    taskId: fixtureTaskId,
    name: 'receipt.pdf',
    size: 210_000,
    progress: 0,
    status: 'queued',
  },
  {
    id: 'u3',
    taskId: fixtureTaskId,
    name: 'raw-footage.mp4',
    size: 30_000_000,
    progress: 0,
    status: 'failed',
    error: 'tooLarge',
    limitBytes: 25 * 1024 * 1024,
  },
  {
    id: 'u4',
    taskId: fixtureTaskId,
    name: 'photo.png',
    size: 300_000,
    progress: 0,
    status: 'failed',
    error: 'mimeMismatch',
  },
  {
    id: 'u5',
    taskId: fixtureTaskId,
    name: 'minutes.docx',
    size: 64_000,
    progress: 0,
    status: 'failed',
    error: 'offline',
  },
];

const palette = [tagPalette.amber, tagPalette.teal, tagPalette.pink, tagPalette.green];

/** A coloured SVG stand-in for a thumbnail (the kitchen sink has no server). */
export function fixtureImageSrc(attachment: Attachment): string {
  const index = Number(attachment.id.slice(-1)) % palette.length;
  const { width = 4, height = 3 } = attachment.image ?? {};
  const colors = palette[index] ?? tagPalette.gray;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${colors.bg}"/><circle cx="${width * 0.7}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.12}" fill="${colors.fg}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
