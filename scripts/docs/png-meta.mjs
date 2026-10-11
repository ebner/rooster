// What a screenshot needs to be shown at its real size, stored in the PNG itself: the pixel
// density (the standard pHYs chunk; 2 for a 2× capture) and the width of the window it was
// taken in (a tEXt chunk), so the guide can tell a crop from a whole screen. Read by
// apps/web/src/features/help/guide-build.ts.
import { crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const VIEWPORT_KEY = 'rooster:viewport';
/** Pixels per metre at 72 dpi, the PNG convention for 1×. */
const PPM_1X = 72 / 0.0254;

function chunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({
      type: png.toString('latin1', at + 4, at + 8),
      bytes: png.subarray(at, at + 12 + length),
    });
    at += 12 + length;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function isViewportText(c) {
  return (
    c.type === 'tEXt' &&
    c.bytes.toString('latin1', 8, 8 + VIEWPORT_KEY.length + 1) === `${VIEWPORT_KEY}\0`
  );
}

/** The PNG with `scale` (device pixels per CSS pixel) and `viewport` (CSS px) recorded. */
export function writeShotMeta(png, { scale, viewport }) {
  const ppm = Math.round(PPM_1X * scale);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys.writeUInt8(1, 8); // unit: metre
  const text = Buffer.from(`${VIEWPORT_KEY}\0${viewport}`, 'latin1');
  const kept = chunks(png).filter((c) => c.type !== 'pHYs' && !isViewportText(c));
  const [ihdr, ...rest] = kept;
  return Buffer.concat([
    SIGNATURE,
    ihdr.bytes,
    chunk('pHYs', phys),
    chunk('tEXt', text),
    ...rest.map((c) => c.bytes),
  ]);
}

/** What `writeShotMeta` recorded, or null for a PNG without it. */
export function readShotMeta(png) {
  const all = chunks(png);
  const phys = all.find((c) => c.type === 'pHYs');
  const text = all.find(isViewportText);
  if (!phys || !text || phys.bytes.readUInt8(16) !== 1) return null;
  return {
    scale: Math.round((phys.bytes.readUInt32BE(8) / PPM_1X) * 100) / 100,
    viewport: Number(
      text.bytes.toString('latin1', 8 + VIEWPORT_KEY.length + 1, text.bytes.length - 4),
    ),
  };
}
