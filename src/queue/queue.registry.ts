/**
 * Queue registry (P1-04)
 * Defines all BullMQ queue names from PRD §25.2
 */

export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  EMAILS: 'emails',
  PUSH: 'push',
  MEDIA: 'media',
  VERIFICATION: 'verification',
  ERRAND_EXPIRY: 'errand-expiry',
  AUTO_COMPLETION: 'auto-completion',
  MARKETPLACE: 'marketplace',
  BILLING: 'billing',
  PAYMENTS: 'payments',
  BADGES: 'badges',
  ANALYTICS: 'analytics',
  CLEANUP: 'cleanup',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Mapping of event types to queue names.
 * Events are routed to queues based on their type.
 */
export const EVENT_TO_QUEUE_MAP: Record<string, QueueName> = {
  // User events
  'user.created': QUEUE_NAMES.NOTIFICATIONS,
  'user.deactivated': QUEUE_NAMES.NOTIFICATIONS,

  // Media events
  'media.confirmed': QUEUE_NAMES.MEDIA,

  // Verification events
  'verification.completed': QUEUE_NAMES.VERIFICATION,
  'verification.failed': QUEUE_NAMES.VERIFICATION,
  'verification.expired': QUEUE_NAMES.VERIFICATION,
  'verification.revoked': QUEUE_NAMES.VERIFICATION,
  'verification.attempts_granted': QUEUE_NAMES.NOTIFICATIONS,

  // Errand events
  'errand.published': QUEUE_NAMES.MARKETPLACE,
  'errand.extended': QUEUE_NAMES.MARKETPLACE,
  'errand.cancelled': QUEUE_NAMES.MARKETPLACE,
  'errand.expired': QUEUE_NAMES.ERRAND_EXPIRY,
  'errand.completed': QUEUE_NAMES.MARKETPLACE,
  'errand.disputed': QUEUE_NAMES.NOTIFICATIONS,
  'errand.status_changed': QUEUE_NAMES.MARKETPLACE,
  'errand.updated': QUEUE_NAMES.NOTIFICATIONS,

  // Offer events
  'offer.created': QUEUE_NAMES.NOTIFICATIONS,
  'offer.updated': QUEUE_NAMES.NOTIFICATIONS,
  'offer.withdrawn': QUEUE_NAMES.NOTIFICATIONS,
  'offer.rejected': QUEUE_NAMES.NOTIFICATIONS,
  'offer.closed': QUEUE_NAMES.NOTIFICATIONS,

  // Assignment events
  'assignment.selected': QUEUE_NAMES.NOTIFICATIONS,
  'assignment.accepted': QUEUE_NAMES.MARKETPLACE,
  'assignment.declined': QUEUE_NAMES.MARKETPLACE,
  'assignment.timed_out': QUEUE_NAMES.MARKETPLACE,
  'assignment.cancelled': QUEUE_NAMES.MARKETPLACE,
  'assignment.completed': QUEUE_NAMES.MARKETPLACE,
  'payment_agreement.updated': QUEUE_NAMES.NOTIFICATIONS,

  // Execution events
  'execution.started': QUEUE_NAMES.MARKETPLACE,
  'execution.picked_up': QUEUE_NAMES.MARKETPLACE,
  'execution.delivered': QUEUE_NAMES.AUTO_COMPLETION,
  'execution.delay_notified': QUEUE_NAMES.NOTIFICATIONS,
  'execution.problem_reported': QUEUE_NAMES.NOTIFICATIONS,
  'execution.problem_resolved': QUEUE_NAMES.NOTIFICATIONS,
  'execution.receipt_added': QUEUE_NAMES.NOTIFICATIONS,

  // Change request events
  'change_request.created': QUEUE_NAMES.NOTIFICATIONS,
  'change_request.accepted': QUEUE_NAMES.MARKETPLACE,
  'change_request.rejected': QUEUE_NAMES.NOTIFICATIONS,
  'change_request.cancelled': QUEUE_NAMES.NOTIFICATIONS,
  'change_request.expired': QUEUE_NAMES.NOTIFICATIONS,

  // Message events
  'message.created': QUEUE_NAMES.NOTIFICATIONS,

  // Rating events
  'rating.created': QUEUE_NAMES.BADGES,

  // Report and dispute events
  'report.created': QUEUE_NAMES.NOTIFICATIONS,
  'dispute.created': QUEUE_NAMES.NOTIFICATIONS,
  'dispute.resolved': QUEUE_NAMES.MARKETPLACE,

  // Subscription events
  'subscription.activated': QUEUE_NAMES.BILLING,
  'subscription.expired': QUEUE_NAMES.BILLING,

  // Boost events
  'boost.activated': QUEUE_NAMES.MARKETPLACE,
  'boost.expired': QUEUE_NAMES.MARKETPLACE,

  // Badge events
  'badge.awarded': QUEUE_NAMES.BADGES,
  'badge.revoked': QUEUE_NAMES.BADGES,
};

/**
 * Get the queue name for an event type.
 * Throws for unknown types: a typo must fail loudly (and dead-letter), not
 * silently route to the wrong queue.
 */
export function getQueueForEvent(eventType: string): QueueName {
  const queue = EVENT_TO_QUEUE_MAP[eventType];
  if (!queue) {
    throw new Error(`No queue mapped for outbox event type "${eventType}"`);
  }
  return queue;
}
