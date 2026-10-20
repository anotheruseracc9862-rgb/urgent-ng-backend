/**
 * Pure billing rules (Backend PRD 22). No database, no clock, no gateway.
 */

import type { OrderType } from '@prisma/client';

/** The commercial product each order type sells (`commercial_products.code`). */
export const PRODUCT_CODE_BY_ORDER_TYPE: Record<OrderType, string> = {
  VERIFICATION_FEE: 'VERIFICATION_FEE',
  RUNNER_PRO: 'RUNNER_PRO',
  BOOST: 'PRIORITY_BOOST',
};

/**
 * The VAT inside a VAT-inclusive price (Backend PRD 22.1): prices are shown VAT-inclusive at
 * `VAT_RATE` percent, so the VAT part is `amount * rate / (100 + rate)`, rounded to a kobo.
 */
export function vatPortion(amountMinor: number, ratePercent: number): number {
  if (amountMinor <= 0 || ratePercent <= 0) return 0;
  return Math.round((amountMinor * ratePercent) / (100 + ratePercent));
}

/** A reference the gateway echoes back. Unique per order and attempt; carries no personal data. */
export function paymentReference(orderId: string, random: string): string {
  return `UNG-${orderId.replace(/-/g, '').slice(-12)}-${random}`;
}

/** Top-level domains reserved for tests and examples (RFC 2606 / 6761). The gateway refuses them as invalid. */
const RESERVED_EMAIL_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);

/**
 * The email the gateway needs for a customer. A phone-only account, or one whose address uses a
 * reserved test domain (such as the local demo accounts), gets a stable placeholder address.
 */
export function gatewayEmail(user: { id: string; email: string | null }): string {
  const tld = user.email?.split('@').pop()?.split('.').pop()?.toLowerCase();
  if (user.email && tld && !RESERVED_EMAIL_TLDS.has(tld)) return user.email;
  return `${user.id}@pay.urgent.ng`;
}

/** Runner Pro period arithmetic in whole days, on timestamps handed in by the caller. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/**
 * The next period when a Runner Pro payment lands. A purchase while the current period is still
 * running extends it from its end (the user keeps the time they already paid for); one after it
 * ended starts now.
 */
export function nextProPeriod(input: { now: Date; currentEnd: Date | null; days: number }): { start: Date; end: Date } {
  const start = input.currentEnd && input.currentEnd.getTime() > input.now.getTime() ? input.currentEnd : input.now;
  return { start, end: addDays(start, input.days) };
}

/** Boost window: the configured length, never past the errand's own deadline. */
export function boostWindow(input: { now: Date; maxHours: number; errandExpiresAt: Date | null }): { activatesAt: Date; expiresAt: Date } | null {
  const natural = new Date(input.now.getTime() + input.maxHours * 3_600_000);
  const expiresAt = input.errandExpiresAt && input.errandExpiresAt.getTime() < natural.getTime() ? input.errandExpiresAt : natural;
  if (expiresAt.getTime() <= input.now.getTime()) return null;
  return { activatesAt: input.now, expiresAt };
}

/** Whether a refund needs a second admin (Backend PRD 22.6): at or above the configured amount. */
export function refundNeedsFourEyes(amountMinor: number, thresholdMinor: number): boolean {
  return amountMinor >= thresholdMinor;
}
