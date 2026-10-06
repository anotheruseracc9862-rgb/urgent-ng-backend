/**
 * Email provider interface (Mailgun)
 */

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface Email {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
}

export interface IEmailProvider {
  /**
   * Send an email
   */
  send(email: Email): Promise<EmailResult>;

  /**
   * Send multiple emails
   */
  sendMultiple(emails: Email[]): Promise<EmailResult[]>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
