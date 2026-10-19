import { describe, it, expect } from 'vitest';
import { buildEmail, buildText, escapeHtml, renderEmail, safeUrl, type EmailSpec } from './email-layout.js';
import { emailBrand } from './email-brand.js';

const brand = { origin: 'https://urgent.ng', logoUrl: 'https://api.urgent.ng/assets/email/logo.png' };

const full: EmailSpec = {
  subject: 'Your Urgent.ng receipt',
  preheader: 'Runner Pro, ₦3,000.',
  badge: { label: 'Paid', tone: 'ok' },
  title: 'Thanks, your payment went through',
  intro: 'Hi Ada, here is your receipt.',
  blocks: [
    { type: 'code', value: '482913', caption: 'Expires in 10 minutes' },
    { type: 'kv', rows: [['Item', 'Runner Pro'], ['Total paid', '₦3,000.00']] },
    { type: 'note', tone: 'danger', title: 'Was this not you?', text: 'Reset your password.' },
    { type: 'steps', items: ['First', 'Second'] },
    { type: 'text', text: 'Some plain words.' },
  ],
  cta: { label: 'View receipt', url: 'https://urgent.ng/profile/orders' },
  closing: 'Keep this email.',
  why: 'You are getting this because you paid.',
};

describe('buildEmail', () => {
  const html = buildEmail(full, brand, { year: 2026 });

  it('is one complete, table-based document with the masthead, the logo and the lime rule', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Your Urgent.ng receipt</title>');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('src="https://api.urgent.ng/assets/email/logo.png"');
    expect(html).toContain('border-bottom:3px solid #a6d445');
    expect(html).not.toContain('<script');
  });

  it('shows every block: code with its label, rows, a note with a left bar, numbered steps, text', () => {
    expect(html).toContain('Your one-time code');
    expect(html).toContain('482913');
    expect(html).toContain('Total paid');
    expect(html).toContain('border-left:3px solid #b42318');
    expect(html).toContain('Was this not you?');
    expect(html).toContain('>1</div>');
    expect(html).toContain('Some plain words.');
  });

  it('has a button with an arrow, and the same link written out for when the button fails', () => {
    expect(html).toContain('href="https://urgent.ng/profile/orders"');
    expect(html).toContain('View receipt&nbsp;&nbsp;&#8594;');
    expect(html).toContain('Button not working?');
  });

  it('carries the preheader hidden, the reason, the help link and the never-ask warning', () => {
    expect(html).toContain('display:none');
    expect(html).toContain('Runner Pro, ₦3,000.');
    expect(html).toContain('You are getting this because you paid.');
    expect(html).toContain('href="https://urgent.ng/help"');
    expect(html).toContain('will never ask for your password, a code, or your NIN or BVN');
    expect(html).toContain('&copy; 2026 Urgent.ng');
  });

  it('supports dark mode in mail apps, and can force either mode for a preview', () => {
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    const forced = buildEmail(full, brand, { forceDark: true });
    expect(forced).not.toContain('@media (prefers-color-scheme: dark)');
    expect(forced).toContain('background:#0f1620 !important');
    expect(buildEmail(full, brand, { forceLight: true })).not.toContain('prefers-color-scheme: dark)');
  });

  it('shrinks for phones', () => {
    expect(html).toContain('@media (max-width:620px)');
    expect(html).toContain('width:100%;max-width:600px');
  });

  it('leaves out what a message does not have', () => {
    const bare = buildEmail({ subject: 's', title: 'Just a title' }, brand);
    expect(bare).not.toContain('Button not working?');
    expect(bare).not.toContain('Your one-time code');
    expect(bare).toContain('You are getting this because it is about your Urgent.ng account.');
  });
});

describe('what reaches the HTML is escaped', () => {
  it('escapes markup in every field a person or a template could influence', () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted"';
    const html = buildEmail({
      subject: hostile, preheader: hostile, badge: { label: hostile, tone: 'warn' }, title: hostile, intro: hostile, closing: hostile, why: hostile,
      blocks: [
        { type: 'code', value: hostile, caption: hostile },
        { type: 'kv', rows: [[hostile, hostile]] },
        { type: 'note', tone: 'info', title: hostile, text: hostile },
        { type: 'steps', items: [hostile] },
        { type: 'text', text: hostile },
      ],
      cta: { label: hostile, url: 'https://urgent.ng/x?a=1&b="2"' },
    }, brand);

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;');
    expect(html).toContain('href="https://urgent.ng/x?a=1&amp;b=&quot;2&quot;"');
  });

  it('only ever links to http or https', () => {
    expect(safeUrl('https://urgent.ng')).toBe('https://urgent.ng');
    expect(safeUrl('HTTP://urgent.ng')).toBe('HTTP://urgent.ng');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', 'mailto:a@b.c', '']) {
      expect(safeUrl(bad)).toBe('#');
    }
    const html = buildEmail({ subject: 's', title: 't', cta: { label: 'Go', url: 'javascript:alert(1)' } }, brand);
    expect(html).not.toContain('javascript:');
  });

  it('escapeHtml handles the five characters that matter', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('buildText', () => {
  const text = buildText(full, brand);

  it('is the same message in plain words, with the link spelled out', () => {
    expect(text.split('\n')[0]).toBe('Thanks, your payment went through');
    expect(text).toContain('Item: Runner Pro');
    expect(text).toContain('Total paid: ₦3,000.00');
    expect(text).toContain('Was this not you?: Reset your password.');
    expect(text).toContain('1. First');
    expect(text).toContain('View receipt: https://urgent.ng/profile/orders');
    expect(text).toContain('Help: https://urgent.ng/help');
    expect(text).toContain('will never ask for your password');
  });

  it('has no HTML and never two blank lines in a row', () => {
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toContain('\n\n\n');
  });
});

describe('renderEmail', () => {
  it('gives the subject, the HTML and the text for an email provider', () => {
    const message = renderEmail(full, brand);
    expect(message.subject).toBe('Your Urgent.ng receipt');
    expect(message.html).toContain('<!doctype html>');
    expect(message.text).toContain('Thanks, your payment went through');
  });
});

describe('emailBrand', () => {
  it('uses the web app and this backend, and serves the logo from the backend', () => {
    expect(emailBrand({ WEB_APP_URL: 'https://urgent.ng/', API_PUBLIC_URL: 'https://api.urgent.ng/' } as NodeJS.ProcessEnv)).toEqual({
      origin: 'https://urgent.ng',
      logoUrl: 'https://api.urgent.ng/assets/email/logo.png',
    });
  });

  it('defaults to the local servers, using the configured port', () => {
    expect(emailBrand({} as NodeJS.ProcessEnv)).toEqual({ origin: 'http://localhost:4001', logoUrl: 'http://localhost:4000/assets/email/logo.png' });
    expect(emailBrand({ PORT: '5000' } as NodeJS.ProcessEnv).logoUrl).toBe('http://localhost:5000/assets/email/logo.png');
  });

  it('lets a different logo be set', () => {
    expect(emailBrand({ EMAIL_LOGO_URL: 'https://cdn.example.com/l.png' } as NodeJS.ProcessEnv).logoUrl).toBe('https://cdn.example.com/l.png');
  });
});
