/**
 * The Urgent.ng email layout: one design, many messages.
 *
 * A message is a small spec (subject, preheader, badge, title, intro, blocks, button, closing).
 * `buildEmail` turns it into email-safe HTML: tables, inline styles, 600px wide, no web fonts, no
 * scripts, with a dark-mode media query. `buildText` makes the plain-text twin. This is a port of
 * `demo/email-templates.js`: change the design there first, then here.
 *
 * Everything that reaches the HTML is escaped, and a link is only ever http or https.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export type EmailBlock =
  | { type: 'code'; value: string; caption?: string }
  | { type: 'kv'; rows: Array<[string, string]> }
  | { type: 'note'; tone: Tone; title?: string; text: string }
  | { type: 'steps'; items: string[] }
  | { type: 'text'; text: string };

export interface EmailSpec {
  subject: string;
  /** The grey line a mail app shows after the subject. */
  preheader?: string;
  badge?: { label: string; tone: Tone };
  title: string;
  intro?: string;
  blocks?: EmailBlock[];
  cta?: { label: string; url: string };
  closing?: string;
  /** Why this person got the email. */
  why?: string;
}

export interface EmailBrand {
  /** The web app, no trailing slash. Help and home links start here. */
  origin: string;
  /** An absolute https image URL. Mail apps cannot load a path. */
  logoUrl: string;
}

export interface BuildOptions {
  /** Used by the preview to show dark mode without waiting for the viewer's setting. */
  forceDark?: boolean;
  forceLight?: boolean;
  year?: number;
}

const C = {
  bg: '#f7f8f7', card: '#ffffff', line: '#e7ebe3', panel: '#f3f5f2',
  ink: '#17212e', ink2: '#344154', muted: '#637080',
  lime: '#a6d445', green: '#526f00', tint: '#f4fbe6',
  ok: '#17723b', okBg: '#e8f7ed', amber: '#9a5b00', amberBg: '#fff4de',
  red: '#b42318', redBg: '#fff0ee', blue: '#2457c5', blueBg: '#eaf1ff',
} as const;

const DARK = {
  bg: '#0f1620', card: '#17212e', line: '#2b3748', panel: '#1d2a3a',
  ink: '#f2f5f8', ink2: '#cfd8e3', muted: '#9aa8b8',
  green: '#b8e255', tint: '#1e2c18',
  ok: '#6fd39a', okBg: '#16301f', amber: '#f2b35c', amberBg: '#3a2a10',
  red: '#ff8d82', redBg: '#3c1a17', blue: '#8fb0ff', blueBg: '#18284a',
} as const;

const TONES: Record<Tone, { fg: keyof typeof C; bg: keyof typeof C }> = {
  ok: { fg: 'ok', bg: 'okBg' },
  warn: { fg: 'amber', bg: 'amberBg' },
  danger: { fg: 'red', bg: 'redBg' },
  info: { fg: 'blue', bg: 'blueBg' },
  neutral: { fg: 'ink2', bg: 'panel' },
};

const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const HELP_PATH = '/help';
const DEFAULT_WHY = 'You are getting this because it is about your Urgent.ng account.';
const NEVER_ASK = 'Urgent.ng will never ask for your password, a code, or your NIN or BVN by email, phone or chat.';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A link in an email is only ever http or https: never javascript:, data: or anything else. */
export function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

function darkCss(force: boolean): string {
  const rules =
    `body,.bg{background:${DARK.bg} !important}` +
    `.card{background:${DARK.card} !important;border-color:${DARK.line} !important}` +
    `.ink{color:${DARK.ink} !important}.ink2{color:${DARK.ink2} !important}.muted{color:${DARK.muted} !important}` +
    `.panel{background:${DARK.panel} !important;border-color:${DARK.line} !important}` +
    `.tint{background:${DARK.tint} !important;border-color:${DARK.line} !important}` +
    `.masthead{background:#101923 !important}.step{background:${DARK.tint} !important;color:${DARK.green} !important}` +
    `.line{border-color:${DARK.line} !important}.rule{background:${DARK.line} !important}` +
    `.link{color:${DARK.green} !important}` +
    `.t-ok{background:${DARK.okBg} !important;color:${DARK.ok} !important}` +
    `.t-warn{background:${DARK.amberBg} !important;color:${DARK.amber} !important}` +
    `.t-danger{background:${DARK.redBg} !important;color:${DARK.red} !important}` +
    `.t-info{background:${DARK.blueBg} !important;color:${DARK.blue} !important}` +
    `.t-neutral{background:${DARK.panel} !important;color:${DARK.ink2} !important}` +
    '.logo-plate{background:#ffffff !important}';
  return force ? rules : `@media (prefers-color-scheme: dark){${rules}}`;
}

function badge(value: EmailSpec['badge']): string {
  if (!value) return '';
  const tone = TONES[value.tone] ?? TONES.neutral;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="t-${value.tone}" style="background:${C[tone.bg]};color:${C[tone.fg]};font:500 12px/16px ${FONT};padding:6px 12px;border-radius:999px">${escapeHtml(value.label)}</td></tr></table>`;
}

function block(item: EmailBlock): string {
  switch (item.type) {
    case 'code':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0"><tr><td align="center" class="tint" style="background:${C.tint};border:1px solid ${C.line};border-radius:16px;padding:24px 12px">` +
        `<div class="ink2" style="font:500 12px/18px ${FONT};color:${C.ink2};margin-bottom:12px">Your one-time code</div>` +
        `<div class="ink code" style="font:600 38px/46px ${FONT};letter-spacing:.18em;color:${C.ink};padding-left:.18em">${escapeHtml(item.value)}</div>` +
        (item.caption ? `<div class="muted" style="font:400 13px/20px ${FONT};color:${C.muted};margin-top:12px">${escapeHtml(item.caption)}</div>` : '') +
        '</td></tr></table>';
    case 'kv': {
      const rows = item.rows.map(([label, value], index) => {
        const last = index === item.rows.length - 1;
        const rule = last ? '' : `border-bottom:1px solid ${C.line};`;
        return `<tr><td class="muted line kv-label" style="font:400 13px/20px ${FONT};color:${C.muted};padding:12px 12px 12px 0;${rule}width:38%;vertical-align:top">${escapeHtml(label)}</td>` +
          `<td class="ink line kv-value" align="right" style="font:500 14px/20px ${FONT};color:${C.ink};padding:12px 0;${rule}vertical-align:top;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`;
      }).join('');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0"><tr><td class="panel" style="background:${C.panel};border-radius:16px;padding:6px 18px">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed">${rows}</table></td></tr></table>`;
    }
    case 'note': {
      const tone = TONES[item.tone] ?? TONES.neutral;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0"><tr><td class="t-${item.tone}" style="background:${C[tone.bg]};border-left:3px solid ${C[tone.fg]};border-radius:0 12px 12px 0;padding:14px 16px;font:400 14px/1.6 ${FONT};color:${C[tone.fg]}">` +
        (item.title ? `<div style="font:600 14px/1.4 ${FONT};margin-bottom:4px">${escapeHtml(item.title)}</div>` : '') + escapeHtml(item.text) + '</td></tr></table>';
    }
    case 'steps': {
      const items = item.items.map((step, index) =>
        `<tr><td valign="top" style="padding:0 12px 12px 0;width:28px"><div class="step" style="width:26px;height:26px;border-radius:13px;background:${C.tint};color:${C.green};font:600 12px/26px ${FONT};text-align:center">${index + 1}</div></td>` +
        `<td class="ink2" style="font:400 14px/1.6 ${FONT};color:${C.ink2};padding:3px 0 12px">${escapeHtml(step)}</td></tr>`).join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px">${items}</table>`;
    }
    case 'text':
      return `<p class="ink2" style="font:400 15px/1.7 ${FONT};color:${C.ink2};margin:0 0 14px">${escapeHtml(item.text)}</p>`;
    default:
      return '';
  }
}

function button(cta: EmailSpec['cta']): string {
  if (!cta) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 6px"><tr><td align="center" bgcolor="${C.lime}" style="border-radius:999px;background:${C.lime}">` +
    `<a class="cta" href="${escapeHtml(safeUrl(cta.url))}" style="display:inline-block;padding:14px 28px;font:600 15px/20px ${FONT};color:${C.ink};text-decoration:none;border-radius:999px">${escapeHtml(cta.label)}&nbsp;&nbsp;&#8594;</a></td></tr></table>`;
}

export function buildEmail(spec: EmailSpec, brand: EmailBrand, options: BuildOptions = {}): string {
  const origin = brand.origin.replace(/\/+$/, '');
  const year = options.year ?? new Date().getFullYear();
  const preheader = spec.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(spec.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>`
    : '';
  const blocks = (spec.blocks ?? []).map(block).join('');
  const ctaUrl = spec.cta ? escapeHtml(safeUrl(spec.cta.url)) : '';
  const fallbackLink = spec.cta
    ? `<p class="muted line" style="font:400 12px/1.6 ${FONT};color:${C.muted};margin:24px 0 0;padding-top:18px;border-top:1px solid ${C.line}">Button not working? Paste this link into your browser:<br><a class="link" href="${ctaUrl}" style="color:${C.green};word-break:break-all;text-decoration:underline">${ctaUrl}</a></p>`
    : '';
  const why = spec.why ?? DEFAULT_WHY;

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(spec.subject)}</title>` +
    '<style>body{margin:0;padding:0}table{mso-table-lspace:0pt;mso-table-rspace:0pt}img{border:0;outline:none}a{text-decoration:none}' +
    '@media (max-width:620px){.wrap{width:100% !important}.outer{padding:16px 8px !important}.pad{padding:26px 24px !important}.masthead{padding:22px 24px !important}.h1{font-size:26px !important}.tagline{font-size:11px !important}.code{font-size:32px !important;letter-spacing:.14em !important}}' +
    (options.forceLight ? '' : darkCss(Boolean(options.forceDark))) + '</style></head>' +
    `<body class="bg" style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-text-size-adjust:100%">${preheader}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.bg}"><tr><td align="center" class="outer" style="padding:28px 12px">` +
    '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">' +
    `<tr><td class="masthead" bgcolor="${C.ink}" style="padding:26px 36px;background:${C.ink};border-radius:22px 22px 0 0;border-bottom:3px solid ${C.lime}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><a href="${escapeHtml(safeUrl(origin))}" class="logo-plate" style="display:inline-block;background:#ffffff;border-radius:12px;padding:8px 12px"><img src="${escapeHtml(safeUrl(brand.logoUrl))}" width="124" alt="Urgent.ng" style="display:block;width:124px;height:auto"></a></td>` +
    `<td class="tagline" align="right" style="font:500 12px/18px ${FONT};color:${C.lime};padding-left:12px">Get it fast.</td></tr></table></td></tr>` +
    `<tr><td class="card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 22px 22px">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="pad" style="padding:34px 36px 30px">' +
    badge(spec.badge) + (spec.badge ? '<div style="height:18px;line-height:18px">&nbsp;</div>' : '') +
    `<h1 class="ink h1" style="margin:0 0 14px;font:600 30px/1.2 ${FONT};letter-spacing:-.03em;color:${C.ink}">${escapeHtml(spec.title)}</h1>` +
    (spec.intro ? `<p class="ink2" style="margin:0 0 6px;font:400 15px/1.7 ${FONT};color:${C.ink2}">${escapeHtml(spec.intro)}</p>` : '') +
    blocks + button(spec.cta) +
    (spec.closing ? `<p class="ink2" style="margin:22px 0 0;font:400 14px/1.7 ${FONT};color:${C.ink2}">${escapeHtml(spec.closing)}</p>` : '') + fallbackLink +
    '</td></tr></table></td></tr>' +
    `<tr><td style="padding:24px 16px 4px"><p class="ink2" style="margin:0 0 14px;font:400 13px/1.7 ${FONT};color:${C.ink2};text-align:center">Need help? <a class="link" href="${escapeHtml(origin)}${HELP_PATH}" style="color:${C.green};font-weight:500;text-decoration:underline">Visit the help centre</a> or reply to this email.</p>` +
    `<p class="muted" style="margin:0 0 10px;font:400 12px/1.7 ${FONT};color:${C.muted};text-align:center">${escapeHtml(why)}</p>` +
    `<p class="muted" style="margin:0;font:400 12px/1.7 ${FONT};color:${C.muted};text-align:center">${NEVER_ASK}</p>` +
    `<p class="muted" style="margin:14px 0 0;font:400 11px/1.7 ${FONT};color:${C.muted};text-align:center">&copy; ${year} Urgent.ng &middot; Get it fast</p></td></tr>` +
    '</table></td></tr></table></body></html>';
}

export function buildText(spec: EmailSpec, brand: EmailBrand): string {
  const origin = brand.origin.replace(/\/+$/, '');
  const out: string[] = [spec.title, '', spec.intro ?? ''];
  for (const item of spec.blocks ?? []) {
    switch (item.type) {
      case 'code':
        out.push('', item.value, item.caption ?? '');
        break;
      case 'kv':
        out.push('');
        for (const [label, value] of item.rows) out.push(`${label}: ${value}`);
        break;
      case 'note':
        out.push('', `${item.title ? `${item.title}: ` : ''}${item.text}`);
        break;
      case 'steps':
        out.push('');
        item.items.forEach((step, index) => out.push(`${index + 1}. ${step}`));
        break;
      case 'text':
        out.push('', item.text);
        break;
    }
  }
  if (spec.cta) out.push('', `${spec.cta.label}: ${safeUrl(spec.cta.url)}`);
  if (spec.closing) out.push('', spec.closing);
  out.push('', '--', spec.why ?? DEFAULT_WHY, `Help: ${origin}${HELP_PATH}`, NEVER_ASK);
  // Never two blank lines in a row.
  return out.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

/** What an email provider needs: the subject, the HTML and its plain-text twin. */
export function renderEmail(spec: EmailSpec, brand: EmailBrand): { subject: string; html: string; text: string } {
  return { subject: spec.subject, html: buildEmail(spec, brand), text: buildText(spec, brand) };
}
