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
      await transporter.sendMail(message);
    },
  };
}
