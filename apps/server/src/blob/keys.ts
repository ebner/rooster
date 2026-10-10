// BlobStore key schemes (04 §4.8, ADR 0049 §3.4). Every key a store touches is checked
// against these shapes, so a key can never climb out of the store's root or bucket prefix.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(
  `^(?:${UUID}/${UUID}(?:\\.thumb\\.webp)?|avatars/${UUID}(?:\\.(?:${UUID}|[0-9]{1,16}))?)$`,
);

export function isValidBlobKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** Throws on any key outside the schemes; stores call it before every operation. */
export function assertBlobKey(key: string): string {
  if (!isValidBlobKey(key)) throw new Error('invalid blob key');
  return key;
}

export const attachmentKey = (orgId: string, attachmentId: string) =>
  assertBlobKey(`${orgId}/${attachmentId}`);

export const thumbKey = (orgId: string, attachmentId: string) =>
  assertBlobKey(`${orgId}/${attachmentId}.thumb.webp`);

/**
 * An avatar: `avatars/<userId>.<avatar_id>` since P11, one object per upload under an id that
 * never repeats, so a blob queued for deletion or left in a backend or bucket that was not
 * configured is never read for a later upload. A number instead of the id: an unreleased build
 * keyed by `avatar_at`. Without either: the shared key of avatars stored before.
 */
export const avatarKey = (userId: string, generation?: string | number) =>
  assertBlobKey(generation === undefined ? `avatars/${userId}` : `avatars/${userId}.${generation}`);
