import type { Attachment } from '@rooster/core/schemas';

/**
 * Pure helpers for the pane's attachments (FR-ATT, 02 §9.2 item 7, ADR 0049 §3): sizes, file
 * kinds, who may delete, what an upload failure means, and which clipboard and drag payloads
 * are files to attach.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** "812 bytes", "48 kB", "2.4 MB" in the UI language (binary multiples, as file managers show). */
export function formatBytes(bytes: number, locale: string): string {
  const [value, unit, digits]: [number, string, number] =
    bytes < KB
      ? [bytes, 'byte', 0]
      : bytes < MB
        ? [bytes / KB, 'kilobyte', 0]
        : bytes < GB
          ? [bytes / MB, 'megabyte', 1]
          : [bytes / GB, 'gigabyte', 1];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    // "812 bytes", but "48 kB" and "2.4 MB".
    unitDisplay: unit === 'byte' ? 'long' : 'short',
    maximumFractionDigits: digits,
  }).format(value);
}

export type FileKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'sheet'
  | 'archive'
  | 'audio'
  | 'video'
  | 'code'
  | 'other';

const extensionKinds: Record<string, FileKind> = {
  pdf: 'pdf',
  txt: 'text',
  md: 'text',
  doc: 'text',
  docx: 'text',
  odt: 'text',
  rtf: 'text',
  pages: 'text',
  csv: 'sheet',
  tsv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  zip: 'archive',
  gz: 'archive',
  tgz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  tar: 'archive',
  json: 'code',
  xml: 'code',
  html: 'code',
  js: 'code',
  ts: 'code',
  py: 'code',
  svg: 'image',
};

/** The icon family for a file: the sniffed type first, then the file name's extension. */
export function fileKind(mime: string, filename: string): FileKind {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (/zip|compressed|x-tar|gzip|x-7z|x-rar/.test(mime)) return 'archive';
  if (/spreadsheet|ms-excel|text\/csv/.test(mime)) return 'sheet';
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  const byName = extension ? extensionKinds[extension] : undefined;
  if (byName) return byName;
  return mime.startsWith('text/') ? 'text' : 'other';
}

/**
 * Raster images (the server measured them): shown as tiles and opened in the lightbox with
 * `?inline=1`. SVG and everything else is a file row that downloads (ADR 0049 §3.2).
 */
export function isRasterImage(attachment: Attachment): boolean {
  return attachment.image !== null;
}

/** 06 §2.7: the uploader or the task's assignee may delete an attachment. */
export function canDeleteAttachment(
  attachment: Pick<Attachment, 'uploaderId'>,
  userId: string,
  assigneeId: string | null,
): boolean {
  return attachment.uploaderId === userId || assigneeId === userId;
}

/** Oldest first (the server's order), images and other files apart. */
export function splitAttachments(attachments: readonly Attachment[]): {
  images: Attachment[];
  files: Attachment[];
} {
  const sorted = [...attachments].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { images: sorted.filter(isRasterImage), files: sorted.filter((a) => !isRasterImage(a)) };
}

export type UploadErrorKind =
  | 'tooLarge'
  | 'storageFull'
  | 'mimeMismatch'
  | 'unsupported'
  | 'tooMany'
  | 'offline'
  | 'forbidden'
  | 'gone'
  | 'failed';

/**
 * What a failed upload means for the person (AC-10.2). A 413 is always the size limit, also
 * when a reverse proxy answered it without a problem body.
 */
export function uploadErrorKind(error: { code?: string; status?: number } | null): UploadErrorKind {
  const code = error?.code;
  const status = error?.status;
  // ADR 0052 §6: past the user's storage quota, not the per-file limit.
  if (code === 'storage_quota_exceeded') return 'storageFull';
  if (status === 413 || code === 'payload_too_large') return 'tooLarge';
  if (code === 'mime_mismatch') return 'mimeMismatch';
  if (status === 415) return 'unsupported';
  if (code === 'too_many_attachments') return 'tooMany';
  if (code === 'network') return 'offline';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'gone';
  return 'failed';
}

/** The limit a 413 problem names (`limitBytes` / `maxBytes`), if the server sent one. */
export function problemLimitBytes(problem: Readonly<Record<string, unknown>> | undefined) {
  const value = problem?.limitBytes ?? problem?.maxBytes;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** The storage the user has used, as a `storage_quota_exceeded` problem names it. */
export function problemUsedBytes(problem: Readonly<Record<string, unknown>> | undefined) {
  const value = problem?.usedBytes;
  return typeof value === 'number' && value >= 0 ? value : undefined;
}

/** True when a drag carries files from outside the page (not text or the list's own drags). */
export function dragHasFiles(data: Pick<DataTransfer, 'types'> | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'));
}

/**
 * The images a paste should attach (ADR 0049 §3.8): a screenshot or a copied image. A paste that
 * also carries plain text (an office app's selection, which adds a picture of itself) stays
 * text for the editor or the field it lands in.
 */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (Array.from(data.types).includes('text/plain')) return [];
  const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'));
  if (files.length > 0) return files;
  // Some browsers expose a pasted image only as an item.
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A pasted screenshot is called "image.png" by every browser; it gets a dated name instead, so
 * several of them stay apart in the list.
 */
export function pastedFileName(
  file: Pick<File, 'name' | 'type'>,
  now: Date,
  /** The translated base name, e.g. `Pasted image {stamp}`. */
  label: (stamp: string) => string,
): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\W.*$/, '') || 'png';
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `${label(stamp)}.${extension}`;
}

/** Wraps around: ← on the first image goes to the last (the lightbox). */
export function stepIndex(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}
