import { describe, expect, test } from 'vitest';
import { fixtureAttachments, fixtureOtherUserId, fixtureUserId } from './fixtures';
import {
  canDeleteAttachment,
  clipboardImageFiles,
  dragHasFiles,
  fileKind,
  formatBytes,
  pastedFileName,
  problemLimitBytes,
  splitAttachments,
  stepIndex,
  uploadErrorKind,
} from './model';

function clipboard(types: string[], files: File[]): DataTransfer {
  return {
    types,
    files: files as unknown as FileList,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })) as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

describe('attachments model (FR-ATT)', () => {
  test('sizes read like a file manager, in the UI language', () => {
    expect(formatBytes(812, 'en')).toBe('812 bytes');
    expect(formatBytes(812, 'sv')).toBe('812 byte');
    expect(formatBytes(48_500, 'en')).toBe('47 kB');
    expect(formatBytes(2_480_000, 'en')).toBe('2.4 MB');
    expect(formatBytes(2_480_000, 'sv')).toBe('2,4 MB');
    expect(formatBytes(3 * 1024 ** 3, 'en')).toBe('3 GB');
  });

  test('file kinds come from the sniffed type, then the extension', () => {
    expect(fileKind('application/pdf', 'x')).toBe('pdf');
    expect(fileKind('image/svg+xml', 'logo.svg')).toBe('image');
    expect(fileKind('application/zip', 'photos.zip')).toBe('archive');
    expect(fileKind('application/octet-stream', 'budget.xlsx')).toBe('sheet');
    expect(fileKind('text/plain', 'notes')).toBe('text');
    expect(fileKind('application/octet-stream', 'blob')).toBe('other');
    expect(fileKind('video/mp4', 'clip.mp4')).toBe('video');
  });

  test('the uploader or the assignee may delete (06 §2.7)', () => {
    const mine = { uploaderId: fixtureUserId };
    expect(canDeleteAttachment(mine, fixtureUserId, null)).toBe(true);
    expect(canDeleteAttachment(mine, fixtureOtherUserId, null)).toBe(false);
    expect(canDeleteAttachment(mine, fixtureOtherUserId, fixtureOtherUserId)).toBe(true);
  });

  test('raster images and other files go apart, oldest first; SVG is a file', () => {
    const { images, files } = splitAttachments([...fixtureAttachments].reverse());
    expect(images.map((a) => a.filename)).toEqual([
      'whiteboard.jpg',
      'floor-plan.png',
      'sunset over the archipelago with a very long file name.webp',
      'huge-scan.tiff.png',
    ]);
    expect(files.map((a) => a.filename)).toContain('logo.svg');
    expect(files[0]?.filename).toBe('Quarterly report Q3.pdf');
  });

  test('upload failures map to what they mean (AC-10.2)', () => {
    expect(uploadErrorKind({ code: 'payload_too_large', status: 413 })).toBe('tooLarge');
    // A proxy's bare 413 is the limit too.
    expect(uploadErrorKind({ code: 'http_413', status: 413 })).toBe('tooLarge');
    expect(uploadErrorKind({ code: 'mime_mismatch', status: 415 })).toBe('mimeMismatch');
    expect(uploadErrorKind({ code: 'unsupported_media_type', status: 415 })).toBe('unsupported');
    expect(uploadErrorKind({ code: 'too_many_attachments', status: 409 })).toBe('tooMany');
    expect(uploadErrorKind({ code: 'network', status: 0 })).toBe('offline');
    expect(uploadErrorKind({ code: 'forbidden', status: 403 })).toBe('forbidden');
    expect(uploadErrorKind({ code: 'not_found', status: 404 })).toBe('gone');
    expect(uploadErrorKind({ code: 'internal', status: 500 })).toBe('failed');
    expect(uploadErrorKind(null)).toBe('failed');
    expect(problemLimitBytes({ limitBytes: 1024 })).toBe(1024);
    expect(problemLimitBytes({ maxBytes: 'x' })).toBeUndefined();
    expect(problemLimitBytes(undefined)).toBeUndefined();
  });

  test('a pasted image attaches; a paste with text (an office selection) stays text', () => {
    const png = new File(['x'], 'image.png', { type: 'image/png' });
    expect(clipboardImageFiles(clipboard(['Files'], [png]))).toEqual([png]);
    expect(clipboardImageFiles(clipboard(['text/html', 'Files'], [png]))).toEqual([png]);
    expect(clipboardImageFiles(clipboard(['text/plain', 'text/html', 'Files'], [png]))).toEqual([]);
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    expect(clipboardImageFiles(clipboard(['Files'], [pdf]))).toEqual([]);
    expect(clipboardImageFiles(null)).toEqual([]);
    // Only an item (no `files`): still found.
    const itemOnly = { ...clipboard(['Files'], [png]), files: [] as unknown as FileList };
    expect(clipboardImageFiles(itemOnly as DataTransfer)).toEqual([png]);
  });

  test('drags count only when they carry files', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true);
    expect(dragHasFiles({ types: ['text/plain'] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  test('a pasted screenshot gets a dated name; a named file keeps its name', () => {
    const now = new Date(2026, 9, 10, 14, 5, 9);
    const label = (stamp: string) => `Pasted image ${stamp}`;
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, now, label)).toBe(
      'Pasted image 2026-10-10 14.05.09.png',
    );
    expect(pastedFileName({ name: '', type: 'image/jpeg' }, now, label)).toBe(
      'Pasted image 2026-10-10 14.05.09.jpg',
    );
    expect(pastedFileName({ name: 'diagram.png', type: 'image/png' }, now, label)).toBe(
      'diagram.png',
    );
  });

  test('the lightbox wraps around', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
