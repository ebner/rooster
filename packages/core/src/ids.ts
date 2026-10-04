/** Validation regex for UUIDv7 ids (05 conventions, D-36). Lowercase only. */
export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RandomBytes = (n: number) => Uint8Array;

const MAX_TIMESTAMP = 2 ** 48 - 1;
const COUNTER_MAX = 0xfff;

const defaultRandom: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export type Uuidv7Generator = (now?: number, random?: RandomBytes) => string;

/**
 * Creates a UUIDv7 generator with its own monotonic state (RFC 9562 §6.2, method 1).
 *
 * The 12-bit `rand_a` field is a counter: it is seeded randomly (top bit cleared, so at least
 * 2048 ids fit in one millisecond) on each new millisecond and incremented for ids generated
 * within the same millisecond. If the counter overflows, or the clock goes backwards, the
 * timestamp is advanced past the last one used so ids always sort in creation order.
 */
export function createUuidv7Generator(): Uuidv7Generator {
  let lastMs = -1;
  let counter = 0;

  return (now = Date.now(), random = defaultRandom) => {
    if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
      throw new RangeError(`uuidv7: timestamp out of range: ${now}`);
    }
    const rand = random(10);
    if (rand.length < 10) throw new RangeError('uuidv7: random source returned too few bytes');
    const r = new DataView(rand.buffer, rand.byteOffset, rand.byteLength);
    const seed = r.getUint16(0) & 0x7ff;

    let ms = now;
    if (ms > lastMs) {
      counter = seed;
    } else {
      ms = lastMs;
      counter += 1;
      if (counter > COUNTER_MAX) {
        ms += 1;
        counter = seed;
      }
    }
    lastMs = ms;

    const out = new DataView(new ArrayBuffer(16));
    out.setUint16(0, Math.floor(ms / 2 ** 32));
    out.setUint32(2, ms % 2 ** 32);
    out.setUint16(6, 0x7000 | counter);
    out.setUint8(8, 0x80 | (r.getUint8(2) & 0x3f));
    for (let i = 9; i < 16; i++) out.setUint8(i, r.getUint8(i - 6));

    const hex = Array.from({ length: 16 }, (_, i) => out.getUint8(i).toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10).join(''),
    ].join('-');
  };
}

/** Generates a UUIDv7 using a process-wide monotonic generator. */
export const uuidv7: Uuidv7Generator = createUuidv7Generator();

export function isUuidv7(value: unknown): value is string {
  return typeof value === 'string' && UUIDV7_REGEX.test(value);
}

/** Returns the ms-epoch timestamp encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidv7(id)) throw new TypeError(`Not a UUIDv7: ${id}`);
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
