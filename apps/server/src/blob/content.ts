import { createReadStream, openAsBlob } from 'node:fs';
import { ATTACHMENT_FILENAME_MAX } from '@rooster/core/limits';
import { fileTypeFromBlob } from 'file-type';
import type { Sharp, SharpOptions } from 'sharp';

/**
 * The raster formats that get a size, a thumbnail and may be shown inline (ADR 0049 §3.3).
 * SVG is deliberately absent: it is a document that can carry script, so it only downloads.
 */
export const RASTER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** Raster extensions and type aliases clients send, by the type they claim. */
const RASTER_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['jfif', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
]);
const RASTER_ALIASES: ReadonlyMap<string, string> = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
]);

/** sharp's `format` names of `RASTER_TYPES` (`heif` covers AVIF). */
const SHARP_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif', 'webp', 'heif']);

export interface Sniffed {
  mime: string;
  /** The extension `file-type` knows for it (no dot), if any. */
  ext: string | null;
}

/**
 * The stored type (ADR 0049 §3.2): sniffed from the content, never the client's claim. An
 * undetected type is `text/plain` for UTF-8 text without NUL bytes, else octet-stream.
 */
export async function sniffFile(path: string): Promise<Sniffed> {
  // Not `fileTypeFromFile`: it imports `strtok3` at runtime by a computed specifier, which the
  // bundle (dist/main.js; the image has no node_modules for it) cannot resolve. A file-backed
  // Blob is read lazily, only as far as the detectors need, and carries the size they use.
  const detected = await fileTypeFromBlob(await openAsBlob(path));
  if (detected !== undefined) return { mime: detected.mime, ext: detected.ext };
  return (await isUtf8Text(path))
    ? { mime: 'text/plain', ext: 'txt' }
    : { mime: 'application/octet-stream', ext: null };
}

async function isUtf8Text(path: string): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer;
      if (bytes.includes(0)) return false;
      decoder.decode(bytes, { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

/**
 * The raster type the client presented the upload as: the part's `Content-Type`, else the
 * file name's extension. Null when it claimed no raster image.
 */
export function declaredRasterType(declaredType: string, filename: string): string | null {
  const type = declaredType.toLowerCase();
  const claimed = RASTER_ALIASES.get(type) ?? type;
  if (RASTER_TYPES.has(claimed)) return claimed;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? (RASTER_EXTENSIONS.get(filename.slice(dot + 1).toLowerCase()) ?? null) : null;
}

/**
 * ADR 0049 §3.2 (10 §5): an upload presented as a raster image whose sniffed type differs, a
 * script disguised as a PNG as much as a JPEG named `.png`.
 */
export function isMimeMismatch(declaredType: string, filename: string, sniffed: string): boolean {
  const claimed = declaredRasterType(declaredType, filename);
  return claimed !== null && claimed !== sniffed;
}

// Bidi overrides and isolates (Trojan Source), the BOM and line/paragraph separators: they
// reorder or hide what a download dialog shows. Joiners stay (emoji sequences need them).
const INVISIBLE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2028\u2029]/gu;

/**
 * The stored file name: the last path segment, NFC, without control and bidi characters,
 * trimmed (and without the trailing dots Windows drops), at most `ATTACHMENT_FILENAME_MAX`
 * characters with the extension kept. Empty → `file` plus the sniffed extension.
 */
export function cleanFilename(raw: string, ext: string | null): string {
  let name = raw.normalize('NFC');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name
    .replace(INVISIBLE, '')
    .trim()
    .replace(/[.\s]+$/u, '');
  if (name === '' || name === '.' || name === '..') {
    return ext === null ? 'file' : `file.${ext}`;
  }
  const chars = Array.from(name);
  if (chars.length <= ATTACHMENT_FILENAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(name.slice(dot)) : [];
  const keep = extension.length > 0 && extension.length <= 16 ? extension : [];
  return [...chars.slice(0, ATTACHMENT_FILENAME_MAX - keep.length), ...keep].join('');
}

// --- images (sharp) ---------------------------------------------------------------------

/** 40 megapixels: larger images are stored but get no thumbnail (ADR 0049 §3.3). */
export const IMAGE_MAX_PIXELS = 40_000_000;
export const THUMB_SIZE = 320;
export const AVATAR_SIZE = 256;

const SHARP_OPTIONS: SharpOptions = { limitInputPixels: IMAGE_MAX_PIXELS, failOn: 'error' };

type SharpFactory = (input: string | Buffer, options?: SharpOptions) => Sharp;
let sharpModule: Promise<SharpFactory> | undefined;

/** sharp is native and only needed for uploads, so it is loaded on first use. */
function loadSharp(): Promise<SharpFactory> {
  sharpModule ??= import('sharp').then((m) => {
    // Uploads are one-off inputs: the operation cache would only hold memory.
    m.default.cache(false);
    return m.default as unknown as SharpFactory;
  });
  return sharpModule;
}

export interface ImageInfo {
  /** Display size, EXIF orientation applied. */
  width: number;
  height: number;
  /** The WebP thumbnail, or null when it could not be made. */
  thumb: Buffer | null;
}

/**
 * Size and thumbnail of a sniffed raster image: a WebP that fits inside 320 × 320, EXIF
 * rotated, never enlarged. Null when sharp cannot read the image at all (it is then kept as
 * a plain file); a failed thumbnail alone keeps the size.
 */
export async function imageInfo(path: string): Promise<ImageInfo | null> {
  const sharp = await loadSharp();
  let width: number;
  let height: number;
  try {
    const meta = await sharp(path, SHARP_OPTIONS).metadata();
    if (meta.format === undefined || !SHARP_FORMATS.has(meta.format)) return null;
    width = meta.autoOrient?.width ?? meta.width;
    height = meta.autoOrient?.height ?? meta.height;
    if (!(width > 0 && height > 0)) return null;
  } catch {
    return null;
  }
  let thumb: Buffer | null = null;
  try {
    thumb = await sharp(path, SHARP_OPTIONS)
      .autoOrient()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    thumb = null;
  }
  return { width, height, thumb };
}

/** The 256 × 256 WebP avatar (cover crop, EXIF rotated); null when it is not a readable image. */
export async function avatarImage(path: string): Promise<Buffer | null> {
  const sharp = await loadSharp();
  try {
    const meta = await sharp(path, SHARP_OPTIONS).metadata();
    if (meta.format === undefined || !SHARP_FORMATS.has(meta.format)) return null;
    return await sharp(path, SHARP_OPTIONS)
      .autoOrient()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}
