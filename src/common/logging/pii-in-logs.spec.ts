/**
 * P12-04: personal data in logs (Backend PRD 27.4). A source scan: no log call may interpolate a
 * value whose name says it holds a phone number, email address, password, one-time code, token,
 * address, contact or message text, and nothing may use `console`. Logs name the record (an id), not
 * the person.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Command-line scripts print to the terminal on purpose.
      if (entry === 'test' || entry === 'scripts') continue;
      out.push(...sourceFiles(path));
    } else if (path.endsWith('.ts') && !/\.(spec|int-spec|d)\.ts$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

/** Names that say the value is personal or secret. */
const RISKY = /\b(phone|email|password|passcode|otp|secret|authorization|cookie|address|addressText|landmark|pickupName|dropoffName|pickupPhone|dropoffPhone|messageBody|body|destination|recipient|pushToken|idToken|accessToken|refreshToken|rawToken|token)\b/i;

/** A log call, up to the closing parenthesis on the same statement (calls here are short). */
const LOG_CALL = /\b(?:this\.)?(?:logger|log)\.(?:log|warn|error|debug|verbose|fatal)\(([\s\S]*?)\);/g;

/** Interpolations that are fine although the name matches: they log a count, a flag or an id. */
const SAFE_INTERPOLATION = /\$\{\s*(?:[\w.]*\.)?(?:\w*(?:Count|Id|Ids|Length|Kind|Type))\s*\}/g;

/** Files that write a code to the log on purpose, with the reason. Development only, refused in production. */
const ALLOWED_TO_LOG_CODES = new Set(['src\\common\\providers\\log-otp.provider.ts', 'src/common/providers/log-otp.provider.ts']);

describe('Personal data in logs (P12-04)', () => {
  const files = sourceFiles('src').filter((file) => !ALLOWED_TO_LOG_CODES.has(file));

  it('does not use console in application code', () => {
    const offenders = files.filter((file) => /\bconsole\.(log|warn|error|debug|info)\(/.test(readFileSync(file, 'utf8')) && !file.endsWith('main.ts'));
    expect(offenders).toEqual([]);
  });

  it('does not interpolate a personal or secret value into a log message', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(LOG_CALL)) {
        scanned += 1;
        const args = call[1].replace(SAFE_INTERPOLATION, '');
        const interpolations = [...args.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
        // The ".message" of an error is not the value named by the variable it came from.
        const risky = interpolations.filter((expr) => RISKY.test(expr.replace(/error(?:\s+instanceof\s+Error)?[\s\S]*?\.message/g, '')));
        if (risky.length > 0) {
          const line = text.slice(0, call.index).split('\n').length;
          offenders.push(`${file}:${line}  \${${risky.join('}, ${')}}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  }, 30_000); // reads every source file, which is slow on a busy machine

  it('keeps the request logger to method, path, status and request id', () => {
    const middleware = readFileSync('src/common/middleware/request-id.middleware.ts', 'utf8');
    expect(middleware).not.toMatch(/req\.body|headers\.authorization|headers\.cookie|req\.query/);
  });
});
