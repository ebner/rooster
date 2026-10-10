import { createTransport } from 'nodemailer';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** Sends one message; rejects when the SMTP server refuses it. Tests inject a fake. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** Bounded so a hanging SMTP server cannot pin the delivery queue. */
const SMTP_TIMEOUT_MS = 30_000;

/** A failed send as it may be logged: nodemailer's code, SMTP status and command only. */
export class SmtpSendError extends Error {
  override readonly name = 'SmtpSendError';

  constructor(
    readonly code: string | undefined,
    readonly responseCode: number | undefined,
    readonly command: string | undefined,
  ) {
    super(
      `SMTP send failed${code === undefined ? '' : ` (${code})`}${
        responseCode === undefined ? '' : `: ${responseCode}`
      }${command === undefined ? '' : ` after ${command}`}`,
    );
  }
}

/**
 * nodemailer's errors quote the server's reply (`550 <someone@example.com>: User unknown`) in
 * their message, `response` and `rejected` fields, and the delivery queue logs what a task
 * throws (ASVS 7.1.2). Only the shape-checked code, status and command are kept; no cause.
 */
export function sanitizeSmtpError(err: unknown): SmtpSendError {
  const fields = (err ?? {}) as { code?: unknown; responseCode?: unknown; command?: unknown };
  const code =
    typeof fields.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(fields.code)
      ? fields.code
      : undefined;
  const responseCode =
    typeof fields.responseCode === 'number' && Number.isInteger(fields.responseCode)
      ? fields.responseCode
      : undefined;
  const command =
    typeof fields.command === 'string' && /^[A-Z][A-Z ]{0,15}$/.test(fields.command)
      ? fields.command
      : undefined;
  return new SmtpSendError(code, responseCode, command);
}

/** nodemailer over `ROOSTER_SMTP_URL` (the only host email goes to; 04 §4.11). */
export function smtpTransport(url: string): MailTransport {
  const transporter = createTransport({
    url,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      try {
        await transporter.sendMail(message);
      } catch (err) {
        throw sanitizeSmtpError(err);
      }
    },
  };
}
