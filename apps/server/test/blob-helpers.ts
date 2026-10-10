import sharp from 'sharp';
import { asJar } from './helpers.ts';
import type { Caller, ListCtx } from './list-helpers.ts';

/** A solid-colour PNG of the given size. */
export function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } },
  })
    .png()
    .toBuffer();
}

/** A JPEG stored `width` × `height` with EXIF orientation 6 (displayed rotated by 90°). */
export function rotatedJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** A multipart form with one `file` part. */
export function fileForm(bytes: Uint8Array | string, filename: string, type?: string): FormData {
  const form = new FormData();
  const data = typeof bytes === 'string' ? bytes : new Uint8Array(bytes);
  form.append('file', new File([data], filename, type === undefined ? {} : { type }));
  return form;
}

/** A multipart request as `caller` (cookie, Origin) to an upload route. */
export function sendForm(
  ctx: Pick<ListCtx, 'app'>,
  caller: Pick<Caller, 'jar'>,
  method: string,
  path: string,
  form: FormData,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(ctx.app.request(path, asJar(caller.jar, { method, body: form, headers })));
}
