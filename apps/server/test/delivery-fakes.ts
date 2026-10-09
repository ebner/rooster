import type { PushPayload } from '@rooster/core/schemas';
import type { MailMessage, MailTransport } from '../src/mail/transport.ts';
import type { PushSender, PushSendOptions, PushTarget } from '../src/push/transport.ts';

export interface SentPush {
  endpoint: string;
  payload: PushPayload;
  options: PushSendOptions;
}

/** A push service that records messages; `failWith` makes chosen endpoints refuse. */
export class FakePush {
  readonly sent: SentPush[] = [];
  /** Endpoint → HTTP status the push service answers with (e.g. 410). */
  readonly failWith = new Map<string, number>();

  /** While set, every send waits for it before the push service "answers". */
  hold: Promise<void> | null = null;

  readonly sender: PushSender = async (target: PushTarget, payload, options) => {
    if (this.hold !== null) await this.hold;
    const status = this.failWith.get(target.endpoint);
    if (status !== undefined) {
      throw Object.assign(new Error(`push service answered ${status}`), { statusCode: status });
    }
    this.sent.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as PushPayload,
      options,
    });
  };

  clear(): void {
    this.sent.length = 0;
  }
}

/** An SMTP server that records messages; `failing` makes every send reject. */
export class FakeMail implements MailTransport {
  readonly sent: MailMessage[] = [];
  failing = false;

  async send(message: MailMessage): Promise<void> {
    if (this.failing) throw new Error('smtp down');
    this.sent.push(message);
  }

  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** Env for an app with SMTP configured (the fake transport replaces the real one). */
export const SMTP_ENV = {
  ROOSTER_SMTP_URL: 'smtp://mail.example.com:587',
  ROOSTER_MAIL_FROM: 'rooster <rooster@example.com>',
} as const;

/** A push endpoint on an allowed push service host. */
export function fcmEndpoint(id: string): string {
  return `https://fcm.googleapis.com/fcm/send/${id}`;
}

/** A plausible browser subscription body for POST /me/push-subscriptions. */
export function subscriptionBody(id: string, userAgent = 'Firefox on Linux') {
  return {
    endpoint: fcmEndpoint(id),
    keys: {
      p256dh:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    },
    userAgent,
  };
}
