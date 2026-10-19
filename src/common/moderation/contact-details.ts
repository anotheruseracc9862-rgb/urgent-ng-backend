import { DomainException } from '../exceptions/domain.exception.js';
import { VALIDATION_ERROR } from '../constants/error-codes.js';

export type ContactDetailKind = 'PHONE' | 'EMAIL';

const EMAIL = /[\w.+-]+\s?(?:@|\(at\)|\[at\])\s?[\w-]+(?:\s?(?:\.|\(dot\)|\[dot\])\s?[\w-]+)+/i;
// A run of digits that may be spaced or dotted like a phone number: "0814 787 7487", "+234 814-787-7487".
const DIGIT_RUN = /\+?\d(?:[\s().-]*\d){8,}/g;

function looksLikePhone(run: string): boolean {
  const digits = run.replace(/\D/g, '');
  if (run.startsWith('+') && digits.length >= 10 && digits.length <= 15) return true;
  if (/^0[789][01]\d{8}$/.test(digits)) return true; // 0814 787 7487
  if (/^234[789][01]\d{8}$/.test(digits)) return true; // 234 814 787 7487
  return /^[789][01]\d{8}$/.test(digits); // 814 787 7487
}

/**
 * Finds a phone number or an email address typed into free text (Nigerian and international
 * formats, with spaces, dots or dashes between the digits). Prices such as "₦5,000" and short
 * numbers are not matched. A heuristic: it stops casual sharing, not a determined workaround.
 */
export function findContactDetails(text: string | null | undefined): ContactDetailKind | null {
  if (!text) return null;
  if (EMAIL.test(text)) return 'EMAIL';
  for (const run of text.match(DIGIT_RUN) ?? []) {
    if (looksLikePhone(run.trim())) return 'PHONE';
  }
  return null;
}

/**
 * Backend PRD 19: phone numbers are shared only after the runner accepts. Until then free text
 * in offers and chat may not carry contact details, so a number cannot go around that rule.
 */
export function assertNoContactDetails(text: string | null | undefined, field: string): void {
  const kind = findContactDetails(text);
  if (!kind) return;
  throw DomainException.of(VALIDATION_ERROR, {
    message: `Phone numbers and email addresses are shared after the runner accepts. Remove the ${kind === 'EMAIL' ? 'email address' : 'phone number'} from your ${field === 'body' ? 'message' : 'note'}.`,
    details: { field, reason: 'CONTACT_DETAILS_BEFORE_ACCEPTANCE', kind },
  });
}
