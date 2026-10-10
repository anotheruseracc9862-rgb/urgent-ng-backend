import type { NotificationCategory } from '@prisma/client';

export interface NotificationTemplateDefault {
  category: NotificationCategory;
  /** `{name}` placeholders are filled from the intent's variables. */
  title: string;
  body: string;
  /** Also send an email (account-critical notices only). */
  email?: true;
}

/**
 * The built-in notification copy, keyed by template (Backend PRD 19.3). An admin can override a
 * template in `notification_templates`; the default here is used when there is no active row.
 *
 * Classes (PRD 19.2): TRANSACTIONAL and SAFETY cannot be switched off. MARKETPLACE and MESSAGING can.
 * Copy never carries message text, phone numbers or exact addresses.
 */
export const TEMPLATE_DEFAULTS: Record<string, NotificationTemplateDefault> = {
  // Offers (optional marketplace class)
  'offer.new': { category: 'MARKETPLACE', title: 'New offer', body: '{runnerName} offered {amount} for "{errandTitle}".' },
  'offer.countered': { category: 'MARKETPLACE', title: 'Counter-offer', body: 'The requester proposed {amount} for "{errandTitle}".' },
  'offer.revised': { category: 'MARKETPLACE', title: 'Offer updated', body: '{runnerName} changed their offer on "{errandTitle}" to {amount}.' },
  'offer.counter_accepted': { category: 'MARKETPLACE', title: 'Counter-offer accepted', body: '{runnerName} accepted {amount} for "{errandTitle}".' },
  'offer.reconfirm_needed': {
    category: 'MARKETPLACE',
    title: 'Errand changed',
    body: '"{errandTitle}" was changed. Reconfirm your offer or withdraw it.',
  },
  'offer.reconfirmed': { category: 'MARKETPLACE', title: 'Offer reconfirmed', body: '{runnerName} reconfirmed their offer on "{errandTitle}".' },
  'offer.withdrawn': { category: 'MARKETPLACE', title: 'Offer withdrawn', body: '{runnerName} withdrew their offer on "{errandTitle}".' },
  'offer.declined': { category: 'MARKETPLACE', title: 'Offer declined', body: 'Your offer on "{errandTitle}" was declined.' },
  'offer.not_selected': { category: 'MARKETPLACE', title: 'Not selected', body: 'Another runner was chosen for "{errandTitle}".' },
  'offer.errand_cancelled': { category: 'MARKETPLACE', title: 'Errand cancelled', body: '"{errandTitle}" was cancelled.' },
  'offer.errand_expired': { category: 'MARKETPLACE', title: 'Errand expired', body: '"{errandTitle}" expired before a runner was chosen.' },

  // Assignment (mandatory service class)
  'assignment.selected': {
    category: 'TRANSACTIONAL',
    title: 'You were selected',
    body: 'Accept "{errandTitle}" before {deadline} to take the job.',
  },
  'assignment.accepted': { category: 'TRANSACTIONAL', title: 'Runner accepted', body: '{runnerName} accepted "{errandTitle}".' },
  'assignment.declined': { category: 'TRANSACTIONAL', title: 'Runner declined', body: '{runnerName} declined "{errandTitle}". Choose another runner.' },
  'assignment.timed_out.requester': {
    category: 'TRANSACTIONAL',
    title: 'No answer from the runner',
    body: '{runnerName} did not accept "{errandTitle}" in time. Choose another runner.',
  },
  'assignment.timed_out.runner': {
    category: 'TRANSACTIONAL',
    title: 'Selection expired',
    body: 'You did not accept "{errandTitle}" in time, so it went back to the requester.',
  },
  'assignment.cancelled.by_requester': { category: 'TRANSACTIONAL', title: 'Errand cancelled', body: 'The requester cancelled "{errandTitle}".' },
  'assignment.cancelled.by_runner': {
    category: 'TRANSACTIONAL',
    title: 'Runner cancelled',
    body: '{runnerName} cancelled "{errandTitle}".',
  },
  'assignment.cancelled.by_platform': { category: 'TRANSACTIONAL', title: 'Errand cancelled', body: '"{errandTitle}" was cancelled by Urgent.ng.' },
  'assignment.acceptance_warning': {
    category: 'TRANSACTIONAL',
    title: 'Accept soon',
    body: 'You have until {deadline} to accept "{errandTitle}".',
  },

  // Execution
  'execution.started': { category: 'TRANSACTIONAL', title: 'Errand started', body: '{runnerName} started "{errandTitle}".' },
  'execution.picked_up': { category: 'TRANSACTIONAL', title: 'Item picked up', body: '{runnerName} picked up the item for "{errandTitle}".' },
  'execution.delivered': {
    category: 'TRANSACTIONAL',
    title: 'Delivered',
    body: '"{errandTitle}" was delivered. Please confirm completion.',
  },
  'execution.delayed': {
    category: 'TRANSACTIONAL',
    title: 'Running late',
    body: '{runnerName} expects about {minutes} more minutes for "{errandTitle}".',
  },
  'execution.problem_reported': {
    category: 'TRANSACTIONAL',
    title: 'Problem reported',
    body: '{runnerName} reported a problem with "{errandTitle}".',
  },
  'execution.problem_resolved': { category: 'TRANSACTIONAL', title: 'Problem resolved', body: 'The problem with "{errandTitle}" was resolved.' },
  'execution.receipt_added': { category: 'MARKETPLACE', title: 'Receipt added', body: '{runnerName} added a receipt photo for "{errandTitle}".' },
  'errand.completed.runner': { category: 'TRANSACTIONAL', title: 'Errand completed', body: 'The requester confirmed "{errandTitle}". Well done.' },
  'errand.auto_completed.requester': {
    category: 'TRANSACTIONAL',
    title: 'Errand completed',
    body: '"{errandTitle}" was completed automatically after delivery.',
  },
  'errand.auto_completed.runner': {
    category: 'TRANSACTIONAL',
    title: 'Errand completed',
    body: '"{errandTitle}" was completed automatically after delivery.',
  },

  // Errand lifecycle
  'errand.expired': { category: 'MARKETPLACE', title: 'Errand expired', body: '"{errandTitle}" expired without a runner. You can repost it.' },
  'errand.expiring': {
    category: 'MARKETPLACE',
    title: 'Errand expiring soon',
    body: '"{errandTitle}" closes at {deadline}. Extend it or choose a runner.',
  },
  'errand.cancelled.by_platform': { category: 'TRANSACTIONAL', title: 'Errand cancelled', body: '"{errandTitle}" was cancelled by Urgent.ng.' },
  'errand.nearby': { category: 'MARKETPLACE', title: 'New errand nearby', body: '"{errandTitle}" in {area}. Make an offer.' },
  'rating.reminder': { category: 'MARKETPLACE', title: 'How did it go?', body: 'Rate your experience with "{errandTitle}".' },

  // Change requests and agreement
  'change_request.created': { category: 'TRANSACTIONAL', title: 'Change requested', body: 'A change was requested for "{errandTitle}". Please respond.' },
  'change_request.accepted': { category: 'TRANSACTIONAL', title: 'Change accepted', body: 'Your change request for "{errandTitle}" was accepted.' },
  'change_request.rejected': { category: 'TRANSACTIONAL', title: 'Change declined', body: 'Your change request for "{errandTitle}" was declined.' },
  'change_request.cancelled': { category: 'TRANSACTIONAL', title: 'Change withdrawn', body: 'The change request for "{errandTitle}" was withdrawn.' },
  'change_request.expired': { category: 'TRANSACTIONAL', title: 'Change expired', body: 'Your change request for "{errandTitle}" expired.' },
  'payment_agreement.updated': {
    category: 'MARKETPLACE',
    title: 'Payment terms updated',
    body: 'The payment terms for "{errandTitle}" changed. Please review and confirm.',
  },
  'payment_agreement.confirmed': {
    category: 'MARKETPLACE',
    title: 'Payment terms confirmed',
    body: 'Both of you confirmed the payment terms for "{errandTitle}".',
  },

  // Verification (account service notices)
  'verification.completed': { category: 'TRANSACTIONAL', title: 'You are verified', body: 'Your identity was verified. You can now make offers.', email: true },
  'verification.failed': {
    category: 'TRANSACTIONAL',
    title: 'Verification did not pass',
    body: 'We could not verify your identity. Open the app to see why and try again.',
    email: true,
  },
  'verification.expired': { category: 'TRANSACTIONAL', title: 'Verification expired', body: 'Your verification expired. Verify again to keep making offers.', email: true },
  'verification.revoked': {
    category: 'TRANSACTIONAL',
    title: 'Verification removed',
    body: 'Your verification was removed. Contact support if you think this is a mistake.',
    email: true,
  },
  'verification.attempts_granted': {
    category: 'TRANSACTIONAL',
    title: 'More attempts available',
    body: 'You can try verifying your identity again.',
  },

  // Chat
  'message.new': { category: 'MESSAGING', title: 'New message', body: '{senderName} sent you a message about "{errandTitle}".' },
};

/** Fill `{name}` placeholders. A missing variable becomes an empty string, never "undefined". */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '');
}

/** Kobo as naira: 50000 becomes "₦500", 12550 becomes "₦125.50". */
export function formatNaira(amountMinor: number): string {
  const naira = amountMinor / 100;
  const text =
    Number.isInteger(naira) ? naira.toLocaleString('en-NG') : naira.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₦${text}`;
}
