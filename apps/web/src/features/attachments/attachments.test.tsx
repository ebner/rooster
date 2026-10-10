import type { Attachment } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DisplayPrefs } from '../../lib/format';
import { AttachmentsView, type AttachmentsViewProps } from './attachments-view';
import {
  fixtureAttachments,
  fixtureImageSrc,
  fixtureNames,
  fixtureOtherUserId,
  fixtureTaskId,
  fixtureUploads,
  fixtureUserId,
} from './fixtures';
import { Lightbox } from './lightbox';
import { isRasterImage } from './model';
import {
  dismissUpload,
  resetUploads,
  retryUpload,
  startUploads,
  useUploadStore,
} from './upload-store';

const uploadMock = vi.hoisted(() => vi.fn());
const changeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../data/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/attachments')>()),
  uploadAttachment: uploadMock,
  afterAttachmentChange: changeMock,
  useUploadLimit: () => 25 * 1024 * 1024,
}));
vi.mock('../../data/me', () => ({
  useMe: () => ({ data: { user: { id: fixtureUserId, name: 'Jannik Lunde' } } }),
  useDisplayPrefs: () => prefs,
}));
vi.mock('../../data/orgs', () => ({ useOrgMembers: () => ({ data: [] }) }));

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 10, 10);
const images = fixtureAttachments.filter(isRasterImage);

function view(props: Partial<AttachmentsViewProps> = {}) {
  const handlers = {
    onPick: vi.fn(),
    onOpenImage: vi.fn(),
    onDelete: vi.fn(async () => undefined),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(
    <AttachmentsView
      attachments={fixtureAttachments}
      uploads={[]}
      userId={fixtureUserId}
      assigneeId={null}
      nameOf={(id) => fixtureNames[id]}
      prefs={prefs}
      now={now}
      online
      maxAttachments={100}
      thumbSrc={fixtureImageSrc}
      downloadHref={(a) => `/api/v1/attachments/${a.id}`}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

/** A controllable upload: resolve or reject it from the test. */
function deferredUpload() {
  let resolve: (a: Attachment) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let progress: (fraction: number) => void = () => {};
  const abort = vi.fn();
  const promise = new Promise<Attachment>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    make: (_file: File, onProgress: (fraction: number) => void) => {
      progress = onProgress;
      return { promise, abort };
    },
    resolve: (a: Attachment) => resolve(a),
    reject: (e: unknown) => reject(e),
    progress: (f: number) => progress(f),
    abort,
  };
}

afterEach(() => {
  resetUploads();
  uploadMock.mockReset();
  changeMock.mockClear();
});

describe('the pane attachments (FR-ATT, 02 §9.2 item 7)', () => {
  test('images form a thumbnail grid; other files are rows with size, uploader and date', () => {
    view();
    const grid = screen.getByRole('list', { name: 'Images' });
    const thumbs = within(grid).getAllByTestId('attachment-thumb');
    expect(thumbs).toHaveLength(4);
    expect(thumbs[0]?.getAttribute('aria-label')).toBe('Open whiteboard.jpg');
    // The image without a thumbnail says so instead of a broken picture.
    expect(within(thumbs[3] as HTMLElement).getByText('No preview')).toBeTruthy();
    const files = screen.getAllByTestId('attachment-file');
    expect(files.map((f) => f.textContent)).toContain(
      'Quarterly report Q3.pdf1.2 MB · Jannik Lunde · Oct 8',
    );
    const pdf = screen.getByRole('link', { name: 'Download Quarterly report Q3.pdf' });
    expect(pdf.getAttribute('href')).toMatch(/^\/api\/v1\/attachments\//);
    expect(pdf.hasAttribute('download')).toBe(true);
    // SVG is never shown inline: it downloads like any file.
    expect(screen.getByRole('link', { name: 'Download logo.svg' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Attachments/ }).textContent).toBe('Attachments9');
  });

  test('only the uploader or the assignee gets a delete button', () => {
    view();
    expect(screen.getByRole('button', { name: 'Delete whiteboard.jpg' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete budget-2027.xlsx' })).toBeNull();
    screen.getAllByRole('button').forEach((b) => {
      expect(b.getAttribute('aria-label')).not.toBe('Delete photos.zip');
    });
  });

  test('the assignee may delete what others uploaded', () => {
    view({ userId: fixtureOtherUserId, assigneeId: fixtureOtherUserId });
    expect(screen.getByRole('button', { name: 'Delete whiteboard.jpg' })).toBeTruthy();
  });

  test('delete asks inline; Escape cancels and focus goes back to the button', async () => {
    const { onDelete } = view();
    const trigger = screen.getByRole('button', { name: 'Delete notes.txt' });
    fireEvent.click(trigger);
    const confirm = screen.getByTestId('attachment-confirm');
    expect(confirm.textContent).toContain('Delete notes.txt? This can’t be undone.');
    fireEvent.keyDown(within(confirm).getByRole('button', { name: 'Delete' }), {
      key: 'Escape',
    });
    expect(screen.queryByTestId('attachment-confirm')).toBeNull();
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(document.activeElement).toBe(trigger);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(screen.getByTestId('attachment-confirm-delete'));
    });
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ filename: 'notes.txt' }));
    expect(screen.queryByTestId('attachment-confirm')).toBeNull();
  });

  test('a failed delete keeps the confirm open', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('500');
    });
    view({ onDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.txt' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('attachment-confirm-delete'));
    });
    expect(screen.getByTestId('attachment-confirm')).toBeTruthy();
  });

  test('offline: a hint, and nothing can be added or deleted', () => {
    view({ online: false });
    expect(screen.getByTestId('attachments-offline').textContent).toContain('You’re offline');
    expect(screen.getByTestId('attach-files').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Delete notes.txt' })).toBeNull();
  });

  test('empty: says how to add files, with a picker', () => {
    const { onPick } = view({ attachments: [] });
    fireEvent.click(screen.getByRole('button', { name: 'choose files' }));
    expect(onPick).toHaveBeenCalled();
  });

  test('uploads show progress; failures say why (AC-10.2)', () => {
    const { onRetry, onDismiss } = view({ attachments: [], uploads: fixtureUploads });
    const rows = screen.getAllByTestId('attachment-upload');
    const bar = within(rows[0] as HTMLElement).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(rows[1]?.textContent).toContain('Waiting…');
    expect(rows[2]?.textContent).toContain(
      'raw-footage.mp4 is too large. Files can be at most 25 MB.',
    );
    expect(rows[3]?.textContent).toContain('photo.png isn’t what its file name says it is');
    expect(within(rows[2] as HTMLElement).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(rows[4] as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('u5');
    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: 'Cancel uploading site-visit.mov',
      }),
    );
    expect(onDismiss).toHaveBeenCalledWith('u1');
  });
});

describe('the lightbox (FR-ATT-2)', () => {
  test('←/→ step through the images (wrapping), Esc closes, download is offered', async () => {
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    render(
      <Lightbox
        images={images}
        index={0}
        onIndexChange={onIndexChange}
        onClose={onClose}
        src={(a) => `/api/v1/attachments/${a.id}?inline=1`}
        downloadHref={(a) => `/api/v1/attachments/${a.id}`}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'whiteboard.jpg, image 1 of 4' });
    expect(within(dialog).getByTestId('lightbox-image').getAttribute('src')).toMatch(/inline=1$/);
    expect(within(dialog).getByTestId('lightbox-download').getAttribute('href')).not.toMatch(
      /inline/,
    );
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    // Focus moves into the lightbox (the dialog itself) and stays there.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(onIndexChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  test('one image: no previous or next', () => {
    render(
      <Lightbox
        images={images.slice(0, 1)}
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        src={fixtureImageSrc}
        downloadHref={() => '#'}
      />,
    );
    expect(screen.queryByTestId('lightbox-next')).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toContain('1 of 1');
  });

  test('an image that fails to load says so and keeps the download', () => {
    render(
      <Lightbox
        images={images}
        index={1}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        src={fixtureImageSrc}
        downloadHref={() => '#'}
      />,
    );
    fireEvent.error(screen.getByTestId('lightbox-image'));
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t show this image');
    expect(screen.getByTestId('lightbox-download')).toBeTruthy();
  });
});

describe('the upload queue', () => {
  const file = (name: string) => new File(['x'], name, { type: 'text/plain' });

  test('files go up one at a time, with progress, and leave the queue when done', async () => {
    const first = deferredUpload();
    const second = deferredUpload();
    const upload = vi.fn().mockImplementationOnce(first.make).mockImplementationOnce(second.make);
    const done = vi.fn();
    startUploads(fixtureTaskId, [file('a.txt'), file('b.txt')], upload, done);
    await act(() => Promise.resolve());
    expect(upload).toHaveBeenCalledTimes(1);
    first.progress(0.5);
    expect(useUploadStore.getState().entries.map((e) => [e.name, e.status, e.progress])).toEqual([
      ['a.txt', 'uploading', 0.5],
      ['b.txt', 'queued', 0],
    ]);
    first.resolve(fixtureAttachments[6] as Attachment);
    await act(() => new Promise((r) => setTimeout(r)));
    expect(done).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);
    second.resolve(fixtureAttachments[5] as Attachment);
    await act(() => new Promise((r) => setTimeout(r)));
    expect(useUploadStore.getState().entries).toEqual([]);
  });

  test('a file over the server limit fails at once with the limit, and is never sent', async () => {
    const upload = vi.fn();
    const big = new File([new Uint8Array(2048)], 'big.bin');
    startUploads(fixtureTaskId, [big], upload, vi.fn(), 1024);
    await act(() => Promise.resolve());
    expect(upload).not.toHaveBeenCalled();
    expect(useUploadStore.getState().entries[0]).toMatchObject({
      status: 'failed',
      error: 'tooLarge',
      limitBytes: 1024,
    });
  });

  test('a proxy 502 is a plain failure, offered for retry', async () => {
    const { ApiError } = await import('../../data/errors');
    const failing = deferredUpload();
    const upload = vi.fn().mockImplementationOnce(failing.make);
    startUploads(fixtureTaskId, [new File(['x'], 'y.bin')], upload, vi.fn(), 100);
    await act(() => Promise.resolve());
    failing.reject(new ApiError('http_502', 502));
    await act(() => new Promise((r) => setTimeout(r)));
    expect(useUploadStore.getState().entries[0]).toMatchObject({
      status: 'failed',
      error: 'failed',
    });
  });

  test('a failure stays with its reason; retry sends it again; dismiss drops it', async () => {
    const { ApiError } = await import('../../data/errors');
    const failing = deferredUpload();
    const upload = vi.fn().mockImplementationOnce(failing.make);
    startUploads(fixtureTaskId, [file('big.bin')], upload, vi.fn());
    await act(() => Promise.resolve());
    failing.reject(new ApiError('payload_too_large', 413, undefined, { limitBytes: 1024 }));
    await act(() => new Promise((r) => setTimeout(r)));
    const [entry] = useUploadStore.getState().entries;
    expect(entry).toMatchObject({ status: 'failed', error: 'tooLarge', limitBytes: 1024 });

    const again = deferredUpload();
    upload.mockImplementationOnce(again.make);
    retryUpload(entry?.id ?? '', upload, vi.fn());
    await act(() => new Promise((r) => setTimeout(r)));
    expect(upload).toHaveBeenCalledTimes(2);
    dismissUpload(entry?.id ?? '');
    expect(again.abort).toHaveBeenCalled();
    again.reject(new ApiError('aborted', 0));
    await act(() => new Promise((r) => setTimeout(r)));
    expect(useUploadStore.getState().entries).toEqual([]);
  });

  test("a proxy's bare 413 names no limit, not the server's (it may enforce a lower one)", async () => {
    const { ApiError } = await import('../../data/errors');
    const failing = deferredUpload();
    startUploads(fixtureTaskId, [file('two-mb.bin')], vi.fn(failing.make), vi.fn(), 25 << 20);
    await act(() => Promise.resolve());
    failing.reject(new ApiError('http_413', 413));
    await act(() => new Promise((r) => setTimeout(r)));
    const [entry] = useUploadStore.getState().entries;
    expect(entry).toMatchObject({ status: 'failed', error: 'tooLarge' });
    expect(entry?.limitBytes).toBeUndefined();
  });

  test('a 401 is handed to the sign-in redirect', async () => {
    const { ApiError } = await import('../../data/errors');
    const { onUnauthenticatedRequest } = await import('../../data/session-events');
    const seen = vi.fn();
    const stop = onUnauthenticatedRequest(seen);
    try {
      const failing = deferredUpload();
      startUploads(fixtureTaskId, [file('a.txt')], vi.fn(failing.make), vi.fn());
      await act(() => Promise.resolve());
      failing.reject(new ApiError('unauthenticated', 401));
      await act(() => new Promise((r) => setTimeout(r)));
      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    } finally {
      stop();
    }
  });

  test("the end of the session drops every upload; a late answer reaches no one's cache", async () => {
    const { ApiError } = await import('../../data/errors');
    const { sessionDataCleared } = await import('../../data/session-events');
    const inFlight = deferredUpload();
    const failed = deferredUpload();
    const upload = vi
      .fn()
      .mockImplementationOnce(failed.make)
      .mockImplementationOnce(inFlight.make);
    const done = vi.fn();
    startUploads(fixtureTaskId, [file('failed.txt')], upload, done);
    await act(() => Promise.resolve());
    failed.reject(new ApiError('http_502', 502));
    await act(() => new Promise((r) => setTimeout(r)));
    startUploads('other-task', [file('busy.txt'), file('queued.txt')], upload, done);
    await act(() => Promise.resolve());
    expect(useUploadStore.getState().entries.map((e) => e.status)).toEqual([
      'failed',
      'uploading',
      'queued',
    ]);

    sessionDataCleared();
    expect(useUploadStore.getState().entries).toEqual([]);
    expect(inFlight.abort).toHaveBeenCalled();
    // The XHR had already completed: its result is dropped, and the queue does not go on.
    inFlight.resolve(fixtureAttachments[6] as Attachment);
    await act(() => new Promise((r) => setTimeout(r)));
    expect(done).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(useUploadStore.getState().entries).toEqual([]);
  });
});

describe('the pane as drop zone and paste target (ADR 0049 §3.8)', () => {
  let online = true;
  beforeEach(() => {
    online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  });
  afterEach(() => vi.restoreAllMocks());

  async function renderPanel() {
    const { AttachmentsPanel } = await import('./attachments-panel');
    const paneRef = createRef<HTMLDivElement>();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <div data-pane-root>
          <div ref={paneRef} data-testid="pane-body">
            <div contentEditable data-testid="editor" suppressContentEditableWarning>
              text
            </div>
            <AttachmentsPanel
              orgId="org"
              taskId={fixtureTaskId}
              userId={fixtureUserId}
              assigneeId={null}
              attachments={[]}
              paneRef={paneRef}
            />
          </div>
        </div>
      </QueryClientProvider>,
    );
  }

  test('a pasted screenshot in the editor becomes an attachment, never inline content', async () => {
    uploadMock.mockImplementation(deferredUpload().make);
    await renderPanel();
    const editor = screen.getByTestId('editor');
    const inEditor = vi.fn();
    editor.addEventListener('paste', inEditor);
    const png = new File(['x'], 'image.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        types: ['Files'],
        files: [png],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
      },
    });
    await act(async () => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(inEditor).not.toHaveBeenCalled();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const sent = uploadMock.mock.calls[0]?.[1] as File;
    expect(sent.name).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
    expect(screen.getByTestId('attachment-upload').textContent).toContain('Pasted image');
  });

  test('dropping files anywhere on the pane shows the overlay, then uploads them', async () => {
    uploadMock.mockImplementation(deferredUpload().make);
    await renderPanel();
    const editor = screen.getByTestId('editor');
    const doc = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = { types: ['Files'], files: [doc], dropEffect: 'none' };
    fireEvent.dragEnter(editor, { dataTransfer });
    expect(screen.getByTestId('attachment-drop-overlay').textContent).toContain('Drop to attach');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    await act(async () => {
      editor.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.queryByTestId('attachment-drop-overlay')).toBeNull();
    expect(uploadMock).toHaveBeenCalledWith(fixtureTaskId, doc, expect.any(Function));
  });

  test('a text drag (the editor’s own) is left alone', async () => {
    await renderPanel();
    fireEvent.dragEnter(screen.getByTestId('editor'), { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByTestId('attachment-drop-overlay')).toBeNull();
  });

  test('offline, a dropped file is not queued', async () => {
    online = false;
    await renderPanel();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['Files'], files: [new File(['x'], 'a.txt')] },
    });
    await act(async () => {
      screen.getByTestId('editor').dispatchEvent(drop);
    });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(useUploadStore.getState().entries).toEqual([]);
  });
});
