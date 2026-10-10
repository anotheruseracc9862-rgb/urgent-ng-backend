/**
 * Real email provider over generic SMTP (Backend Build Plan P8-06). Resend, Mailgun, SES or any
 * SMTP service works by changing environment values only; no vendor SDK is imported.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Email, EmailResult, IEmailProvider } from './email.provider.js';

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** The default From address, for example `Urgent.ng <no-reply@urgent.ng>`. */
  from: string;
}

/** The part of a nodemailer transport this adapter uses, so tests can supply one. */
export type MailTransport = Pick<Transporter, 'sendMail'>;

export class SmtpEmailProvider implements IEmailProvider {
  private readonly transport: MailTransport;

  constructor(
    private readonly settings: SmtpSettings,
    transport?: MailTransport,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        // 465 is implicit TLS; other ports upgrade with STARTTLS when the server offers it.
        secure: settings.port === 465,
        auth: { user: settings.user, pass: settings.pass },
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async send(email: Email): Promise<EmailResult> {
    try {
      const info = await this.transport.sendMail({
        from: email.from ?? this.settings.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        replyTo: email.replyTo,
        attachments: email.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      const rejected = Array.isArray(info.rejected) ? info.rejected : [];
      if (rejected.length > 0) {
        return { success: false, error: 'The address was rejected by the mail server.' };
      }
      return { success: true, messageId: typeof info.messageId === 'string' ? info.messageId : undefined };
    } catch (error) {
      // The message never includes the body or the recipient, only what the server said.
      return { success: false, error: error instanceof Error ? error.message : 'SMTP send failed' };
    }
  }

  async sendMultiple(emails: Email[]): Promise<EmailResult[]> {
    const results: EmailResult[] = [];
    for (const email of emails) {
      results.push(await this.send(email));
    }
    return results;
  }
}
