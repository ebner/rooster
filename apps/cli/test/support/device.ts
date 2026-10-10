import type { TestUser } from './rooster-server.ts';

/** A pending device request as the approving user's `/device` page reads it. */
export interface PendingDevice {
  requestedScopes: string[];
  /** Binds the approval or denial to this user and this request (CSRF). */
  decisionNonce: string;
}

/** `GET /device/{userCode}` as the approving user, which hands out the decision nonce. */
export async function pendingDevice(user: TestUser, code: string): Promise<PendingDevice> {
  const pending = await user.api<PendingDevice>('GET', `/api/v1/device/${code}`);
  if (pending.status !== 200) throw new Error(`device ${code}: ${pending.status}`);
  return pending.data;
}

/** Approves the request the way the web page does: read it first, then send its nonce. */
export async function approveDevice(
  user: TestUser,
  code: string,
  body: { scopes: string[]; constraints: unknown },
) {
  const { decisionNonce } = await pendingDevice(user, code);
  return user.api('POST', `/api/v1/device/${code}/approve`, { ...body, decisionNonce });
}

export async function denyDevice(user: TestUser, code: string) {
  const { decisionNonce } = await pendingDevice(user, code);
  return user.api('POST', `/api/v1/device/${code}/deny`, { decisionNonce });
}
