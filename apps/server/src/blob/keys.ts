// BlobStore key schemes (04 §4.8, ADR 0049 §3.4). Every key a store touches is checked
// against these shapes, so a key can never climb out of the store's root or bucket prefix.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^(?:${UUID}/${UUID}(?:\\.thumb\\.webp)?|avatars/${UUID})$`);

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

export const avatarKey = (userId: string) => assertBlobKey(`avatars/${userId}`);
