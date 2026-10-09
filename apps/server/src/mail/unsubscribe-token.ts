import { isUuidv7 } from '@rooster/core/ids';
import { type UnsubscribeCategory, unsubscribeCategorySchema } from '@rooster/core/schemas';
import { hmacBase64, safeEqual } from '../lib/tokens.ts';

/**
 * Unsubscribe links (06 §2.6): `<userId>.<category>.<HMAC>`, signed with the auth secret. They
 * never expire, so a link in an old email keeps working; rotating the secret invalidates them.
 */
function signature(secret: string, userId: string, category: UnsubscribeCategory): string {
  return hmacBase64(secret, `rooster-unsubscribe:${userId}:${category}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function unsubscribeToken(
  secret: string,
  userId: string,
  category: UnsubscribeCategory,
): string {
  return `${userId}.${category}.${signature(secret, userId, category)}`;
}

/** The signed `{userId, category}`, or null for anything malformed or forged. */
export function parseUnsubscribeToken(
  secret: string,
  token: string,
): { userId: string; category: UnsubscribeCategory } | null {
  const [userId, rawCategory, sig, ...rest] = token.split('.');
  if (rest.length > 0 || userId === undefined || sig === undefined) return null;
  if (!isUuidv7(userId)) return null;
  const category = unsubscribeCategorySchema.safeParse(rawCategory);
  if (!category.success) return null;
  return safeEqual(sig, signature(secret, userId, category.data))
    ? { userId, category: category.data }
    : null;
}
