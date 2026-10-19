import type { EmailBrand, EmailSpec } from './email-layout.js';

/**
 * What each email says. The layout is one design (`email-layout.ts`); this file is the words.
 *
 * Copy rules: no exact addresses, phone numbers, message text, or ID numbers in any email, and a
 * security or payment email says it cannot be turned off.
 */

const lagos = (date: Date) =>
  new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }).format(date);
const lagosDay = (date: Date) => new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' }).format(date);

const hi = (firstName?: string | null) => (firstName ? `Hi ${firstName}, ` : '');
const SECURITY_WHY = 'You are getting this security alert because your account details changed. You cannot turn it off.';

/** "482913" is easier to read and to say aloud as "482 913". */
const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

export function otpEmail(code: string, options: { expiresMinutes?: number; firstName?: string | null } = {}): EmailSpec {
  const minutes = options.expiresMinutes ?? 10;
  return {
    subject: `Your Urgent.ng code: ${spaced(code)}`,
    preheader: `Use this code within ${minutes} minutes. Do not share it with anyone.`,
    badge: { label: 'Security code', tone: 'info' },
    title: `Your code is ${spaced(code)}`,
    intro: `${hi(options.firstName)}enter this code on Urgent.ng to continue.`,
    blocks: [
      { type: 'code', value: code, caption: `Expires in ${minutes} minutes` },
      { type: 'note', tone: 'warn', title: 'Keep it to yourself', text: 'Urgent.ng staff will never ask you for this code. If someone does, it is a scam.' },
    ],
    closing: 'Did not ask for a code? You can ignore this email. Nothing changes until the code is used.',
    why: 'You are getting this because someone entered your email on Urgent.ng.',
  };
}

export function adminInviteEmail(options: { link: string | null; token: string; hours: number }): EmailSpec {
  return {
    subject: 'You have been invited to the Urgent.ng admin console',
    preheader: `Accept your invitation within ${options.hours} hours.`,
    badge: { label: 'Admin invitation', tone: 'info' },
    title: 'You are invited to the admin console',
    intro: `Accept your invitation within ${options.hours} hours. After that it expires and you will need a new one.`,
    blocks: options.link ? [] : [{ type: 'code', value: options.token, caption: 'Your invitation code' }],
    ...(options.link ? { cta: { label: 'Accept the invitation', url: options.link } } : {}),
    closing: 'Did not expect this? Ignore this email. Nothing happens unless the invitation is accepted.',
    why: 'You are getting this because an Urgent.ng administrator invited you.',
  };
}

export interface NotificationEmailInput {
  /** The notification template key, for example `billing.receipt`. */
  type: string;
  title: string;
  body: string;
  firstName?: string | null;
  /** The values the notification was written from. Only some emails use them. */
  vars?: Record<string, string>;
  now?: Date;
}

/** The email for an account notice: a specific design for each known type, a plain one for the rest. */
export function notificationEmail(input: NotificationEmailInput, brand: EmailBrand): EmailSpec {
  const { type, title, body, firstName } = input;
  const vars = input.vars ?? {};
  const now = input.now ?? new Date();
  const link = (path: string) => `${brand.origin}${path}`;

  switch (type) {
    case 'billing.receipt': {
      const product = vars.product || 'Urgent.ng';
      return {
        subject: `Your Urgent.ng receipt: ${product}`,
        preheader: `${product}, ${vars.amount ?? ''}. Reference ${vars.reference ?? ''}.`.replace(/\s+\./g, '.'),
        badge: { label: 'Paid', tone: 'ok' },
        title: 'Thanks, your payment went through',
        intro: `${hi(firstName)}here is your receipt.`,
        blocks: [{
          type: 'kv',
          rows: [
            ['Item', product],
            ['Total paid', vars.amount ?? ''],
            ['VAT included', vars.vat ?? ''],
            ['Reference', vars.reference ?? ''],
            ['Date', lagosDay(now)],
          ].filter((row): row is [string, string] => row[1] !== ''),
        }],
        cta: { label: 'View receipt', url: link('/profile/orders') },
        closing: 'Keep this email for your records.',
        why: 'You are getting this because you made a payment on Urgent.ng. You cannot turn it off.',
      };
    }
    case 'account.password_changed':
      return {
        subject: title,
        preheader: 'If this was not you, secure your account now.',
        badge: { label: 'Security alert', tone: 'danger' },
        title: 'Your password was changed',
        intro: `${hi(firstName)}the password on your Urgent.ng account was changed.`,
        blocks: [
          { type: 'kv', rows: [['When', `${lagos(now)} (Lagos)`]] },
          { type: 'note', tone: 'danger', title: 'Was this not you?', text: 'Reset your password straight away. Then check your account for anything you do not recognise.' },
        ],
        cta: { label: 'Secure my account', url: link('/forgot-password') },
        closing: 'If it was you, there is nothing more to do.',
        why: SECURITY_WHY,
      };
    case 'account.contact_changed':
      return {
        subject: title,
        preheader: 'If this was not you, contact support now.',
        badge: { label: 'Security alert', tone: 'danger' },
        title: 'Your contact details changed',
        intro: `${hi(firstName)}the phone number or email on your Urgent.ng account was changed.`,
        blocks: [
          { type: 'kv', rows: [['When', `${lagos(now)} (Lagos)`]] },
          { type: 'note', tone: 'danger', title: 'Was this not you?', text: 'Contact support now, then reset your password. Whoever changed it could use it to sign in.' },
        ],
        cta: { label: 'Review my account', url: link('/settings/security') },
        closing: 'If it was you, there is nothing more to do.',
        why: SECURITY_WHY,
      };
    case 'verification.completed':
      return {
        subject: title,
        preheader: 'You can now make offers on errands.',
        badge: { label: 'Verified', tone: 'ok' },
        title: 'You are verified',
        intro: `${hi(firstName)}your identity check is complete. You can now make offers and take errands.`,
        blocks: [{ type: 'steps', items: ['Finish your runner profile and pick your work area.', 'Set yourself as available.', 'Make your first offer on an errand near you.'] }],
        cta: { label: 'Browse errands', url: link('/marketplace') },
        closing: 'Your ID number is never stored. We only keep the result of the check.',
        why: 'You are getting this because your identity check finished.',
      };
    case 'verification.failed':
      return {
        subject: title,
        preheader: 'Open Urgent.ng to see what to check before you try again.',
        badge: { label: 'Action needed', tone: 'warn' },
        title: 'We could not verify you yet',
        intro: `${hi(firstName)}we could not confirm your identity. This happens a lot and is usually easy to fix.`,
        blocks: [{ type: 'note', tone: 'warn', title: 'What to check', text: 'Open Urgent.ng to see exactly what did not match: the name, the date of birth, the ID number or the selfie.' }],
        cta: { label: 'Try again', url: link('/verification') },
        closing: 'Still stuck after a second try? Contact support and mention the time of your attempt.',
        why: 'You are getting this because an identity check on your account did not pass.',
      };
    case 'verification.expired':
      return {
        subject: title,
        preheader: 'Verify again to keep making offers.',
        badge: { label: 'Action needed', tone: 'warn' },
        title: 'Your verification expired',
        intro: `${hi(firstName)}your identity verification has expired. Verify again to keep making offers.`,
        cta: { label: 'Verify again', url: link('/verification') },
        why: 'You are getting this because your verification reached its end date.',
      };
    case 'verification.revoked':
      return {
        subject: title,
        preheader: 'Contact support if you think this is a mistake.',
        badge: { label: 'Account notice', tone: 'danger' },
        title: 'Your verification was removed',
        intro: `${hi(firstName)}your identity verification was removed from your account.`,
        blocks: [{ type: 'note', tone: 'danger', text: 'You cannot make offers until you are verified again. Contact support if you think this is a mistake.' }],
        cta: { label: 'Contact support', url: link('/help') },
        why: 'You are getting this because the verification on your account changed. You cannot turn it off.',
      };
    case 'system.announcement':
      return {
        subject: title,
        preheader: body.length > 110 ? `${body.slice(0, 107)}...` : body,
        badge: { label: 'Service notice', tone: 'info' },
        title,
        blocks: [{ type: 'text', text: body }],
        why: 'You are getting this because it is a service notice from Urgent.ng. You cannot turn it off.',
      };
    default:
      return {
        subject: title,
        preheader: body.length > 110 ? `${body.slice(0, 107)}...` : body,
        title,
        intro: body,
        why: 'You are getting this because it is about your Urgent.ng account.',
      };
  }
}
