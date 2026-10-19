import { describe, it, expect } from 'vitest';
import { TEMPLATE_DEFAULTS } from '../notification-templates.js';
import { buildEmail, buildText } from './email-layout.js';
import { adminInviteEmail, notificationEmail, otpEmail } from './email-messages.js';

const brand = { origin: 'https://urgent.ng', logoUrl: 'https://api.urgent.ng/assets/email/logo.png' };
const now = new Date('2026-10-18T13:07:00.000Z');

describe('one-time code email', () => {
  it('shows the code in the box, reads it as 482 913, and says it expires', () => {
    const spec = otpEmail('482913', { firstName: 'Ada' });
    expect(spec.subject).toBe('Your Urgent.ng code: 482 913');
    expect(spec.title).toBe('Your code is 482 913');
    expect(spec.intro).toBe('Hi Ada, enter this code on Urgent.ng to continue.');
    expect(spec.blocks).toContainEqual({ type: 'code', value: '482913', caption: 'Expires in 10 minutes' });
    expect(spec.preheader).toContain('10 minutes');
    expect(buildEmail(spec, brand)).toContain('Urgent.ng staff will never ask you for this code');
  });

  it('works without a name and with another lifetime', () => {
    const spec = otpEmail('123456', { expiresMinutes: 5 });
    expect(spec.intro).toBe('enter this code on Urgent.ng to continue.'.replace(/^e/, 'e'));
    expect(spec.blocks?.[0]).toMatchObject({ caption: 'Expires in 5 minutes' });
  });
});

describe('admin invitation email', () => {
  it('has a button when there is a link, and shows the code when there is not', () => {
    const withLink = adminInviteEmail({ link: 'https://admin.urgent.ng/accept-invite?token=abc', token: 'abc', hours: 72 });
    expect(withLink.cta).toEqual({ label: 'Accept the invitation', url: 'https://admin.urgent.ng/accept-invite?token=abc' });
    expect(withLink.blocks).toEqual([]);
    const without = adminInviteEmail({ link: null, token: 'abc', hours: 72 });
    expect(without.cta).toBeUndefined();
    expect(without.blocks).toContainEqual({ type: 'code', value: 'abc', caption: 'Your invitation code' });
    expect(without.intro).toContain('72 hours');
  });
});

describe('account notice emails', () => {
  const make = (type: string, extra: { vars?: Record<string, string>; firstName?: string } = {}) =>
    notificationEmail({ type, title: TEMPLATE_DEFAULTS[type]?.title ?? 'Title', body: TEMPLATE_DEFAULTS[type]?.body ?? 'Body', now, ...extra }, brand);

  it('receipt: the payment, the VAT, the reference and a link to the orders', () => {
    const spec = make('billing.receipt', { firstName: 'Musa', vars: { product: 'Runner Pro', amount: '₦3,000.00', vat: '₦209.30', reference: 'UG-1' } });
    expect(spec.subject).toBe('Your Urgent.ng receipt: Runner Pro');
    expect(spec.badge).toEqual({ label: 'Paid', tone: 'ok' });
    expect(spec.intro).toBe('Hi Musa, here is your receipt.');
    expect(spec.blocks?.[0]).toMatchObject({ type: 'kv', rows: expect.arrayContaining([['Item', 'Runner Pro'], ['Total paid', '₦3,000.00'], ['VAT included', '₦209.30'], ['Reference', 'UG-1']]) });
    expect(spec.cta).toEqual({ label: 'View receipt', url: 'https://urgent.ng/profile/orders' });
    expect(spec.why).toContain('You cannot turn it off');
  });

  it('receipt: leaves out a row it has no value for rather than showing an empty one', () => {
    const spec = make('billing.receipt', { vars: { product: 'Runner Pro' } });
    const kv = spec.blocks?.find((item) => item.type === 'kv');
    const rows = kv && kv.type === 'kv' ? kv.rows.map(([label]) => label) : [];
    expect(rows).toEqual(['Item', 'Date']);
  });

  it('password changed: a security alert that says when, and where to secure the account', () => {
    const spec = make('account.password_changed', { firstName: 'Ada' });
    expect(spec.badge).toEqual({ label: 'Security alert', tone: 'danger' });
    expect(spec.blocks).toContainEqual(expect.objectContaining({ type: 'kv', rows: [['When', expect.stringMatching(/^18 Oct 2026, .+ \(Lagos\)$/)]] }));
    expect(spec.cta?.url).toBe('https://urgent.ng/forgot-password');
    expect(spec.why).toContain('You cannot turn it off');
  });

  it('contact changed: goes to the security settings', () => {
    expect(make('account.contact_changed').cta).toEqual({ label: 'Review my account', url: 'https://urgent.ng/settings/security' });
  });

  it.each([
    ['verification.completed', 'ok', '/marketplace'],
    ['verification.failed', 'warn', '/verification'],
    ['verification.expired', 'warn', '/verification'],
    ['verification.revoked', 'danger', '/help'],
  ])('%s: badge tone %s, button to %s', (type, tone, path) => {
    const spec = make(type);
    expect(spec.badge?.tone).toBe(tone);
    expect(spec.cta?.url).toBe(`https://urgent.ng${path}`);
  });

  it('service notice: the admin message in a plain block, never in HTML', () => {
    const spec = notificationEmail({ type: 'system.announcement', title: 'Service notice', body: '<b>Maintenance</b> on Sunday', now }, brand);
    expect(spec.badge).toEqual({ label: 'Service notice', tone: 'info' });
    expect(spec.blocks).toEqual([{ type: 'text', text: '<b>Maintenance</b> on Sunday' }]);
    expect(buildEmail(spec, brand)).not.toContain('<b>Maintenance</b>');
    expect(buildEmail(spec, brand)).toContain('&lt;b&gt;Maintenance&lt;/b&gt; on Sunday');
  });

  it('an unknown type still gets a clean email from its title and body', () => {
    const spec = notificationEmail({ type: 'something.new', title: 'A title', body: 'A body.', now }, brand);
    expect(spec).toMatchObject({ subject: 'A title', title: 'A title', intro: 'A body.' });
  });

  it('a long body is shortened for the preview line', () => {
    const spec = notificationEmail({ type: 'system.announcement', title: 'T', body: 'x'.repeat(300), now }, brand);
    expect(spec.preheader?.length).toBe(110);
  });
});

describe('every notification that sends an email builds a good one', () => {
  const emailTypes = Object.entries(TEMPLATE_DEFAULTS).filter(([, template]) => template.email).map(([key]) => key);

  it('there is at least the set we expect', () => {
    expect(emailTypes).toEqual(expect.arrayContaining(['billing.receipt', 'account.password_changed', 'account.contact_changed', 'verification.completed', 'verification.failed', 'system.announcement']));
  });

  it.each(emailTypes)('%s: HTML and text, a subject, links on the web app, nothing unescaped', (type) => {
    const template = TEMPLATE_DEFAULTS[type];
    const spec = notificationEmail({ type, title: template.title, body: template.body, firstName: 'Ada <b>', vars: { product: 'Runner Pro', amount: '₦1', vat: '₦0', reference: 'R' }, now }, brand);
    const html = buildEmail(spec, brand);
    const text = buildText(spec, brand);

    expect(spec.subject.length).toBeGreaterThan(0);
    expect(html).toContain('<h1');
    // The name is hostile on purpose: in the HTML it must be escaped.
    expect(html).not.toContain('Ada <b>');
    if (spec.cta) expect(spec.cta.url.startsWith('https://urgent.ng/')).toBe(true);
    expect(text.length).toBeGreaterThan(50);
    expect(text).not.toContain('<h1');
  });
});

describe('no email carries what it must not', () => {
  it('never puts a phone number, an exact address or an ID number in any built-in message', () => {
    const everything = [
      otpEmail('482913'),
      adminInviteEmail({ link: null, token: 't', hours: 72 }),
      ...Object.entries(TEMPLATE_DEFAULTS).filter(([, template]) => template.email).map(([type, template]) => notificationEmail({ type, title: template.title, body: template.body, now }, brand)),
    ].map((spec) => buildText(spec, brand)).join('\n');

    expect(everything).not.toMatch(/\+?234\d{9,10}|\b0[789][01]\d{8}\b/);
    expect(everything).not.toMatch(/\b\d{11}\b/);
  });
});
