import { afterEach, describe, expect, test, vi } from 'vitest';
import { attachmentUrl, sendMultipart, thumbnailUrl } from './attachments';
import { avatarFileProblem, isUploadedAvatar } from './avatar';
import { ApiError } from './errors';

/** A minimal XMLHttpRequest double: the test answers it. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('attachment uploads (06 §2.7, ADR 0049 §3.8)', () => {
  test('one multipart `file`, the web client header, progress, and the created attachment', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress = vi.fn();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const upload = sendMultipart('POST', '/api/v1/tasks/t1/attachments', file, file.name, progress);
    const xhr = FakeXhr.last as FakeXhr;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toMatch(/\/api\/v1\/tasks\/t1\/attachments$/);
    expect(xhr.headers['X-Rooster-Client']).toBe('web');
    expect((xhr.body?.get('file') as File | undefined)?.name).toBe('notes.txt');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    expect(progress).toHaveBeenCalledWith(0.5);
    xhr.respond(201, { id: 'a1' });
    await expect(upload.promise).resolves.toEqual({ id: 'a1' });
  });

  test('a problem answer rejects with its code; a proxy 413 and network errors too', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File(['x'], 'big.bin');
    const problem = sendMultipart('POST', '/x', file, 'big.bin');
    (FakeXhr.last as FakeXhr).respond(413, { code: 'payload_too_large', status: 413 });
    await expect(problem.promise).rejects.toMatchObject({ code: 'payload_too_large', status: 413 });

    const proxy = sendMultipart('POST', '/x', file, 'big.bin');
    (FakeXhr.last as FakeXhr).respond(413, '<html>Request Entity Too Large</html>');
    await expect(proxy.promise).rejects.toMatchObject({ code: 'http_413', status: 413 });

    const network = sendMultipart('POST', '/x', file, 'big.bin');
    (FakeXhr.last as FakeXhr).onerror?.();
    await expect(network.promise).rejects.toBeInstanceOf(ApiError);
    await expect(network.promise).rejects.toMatchObject({ code: 'network' });

    const aborted = sendMultipart('POST', '/x', file, 'big.bin');
    aborted.abort();
    await expect(aborted.promise).rejects.toMatchObject({ code: 'aborted' });
  });

  test('download, inline and thumbnail URLs', () => {
    expect(attachmentUrl('a1')).toBe('/api/v1/attachments/a1');
    expect(attachmentUrl('a1', { inline: true })).toBe('/api/v1/attachments/a1?inline=1');
    expect(thumbnailUrl('a1')).toBe('/api/v1/attachments/a1/thumb');
  });
});

describe('avatar checks (FR-SET-1)', () => {
  test('raster images up to 2 MB; an uploaded picture is ours', () => {
    expect(avatarFileProblem({ type: 'image/png', size: 1000 })).toBeNull();
    expect(avatarFileProblem({ type: 'image/svg+xml', size: 1000 })).toBe('type');
    expect(avatarFileProblem({ type: 'image/jpeg', size: 2 * 1024 * 1024 + 1 })).toBe('size');
    expect(isUploadedAvatar('/api/v1/avatars/u1?v=3', 'u1')).toBe(true);
    expect(isUploadedAvatar('https://lh3.googleusercontent.com/a/x', 'u1')).toBe(false);
    expect(isUploadedAvatar(null, 'u1')).toBe(false);
  });
});
