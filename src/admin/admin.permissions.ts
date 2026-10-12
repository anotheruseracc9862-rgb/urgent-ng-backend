/**
 * Admin permissions (Backend PRD 24.2). Authorisation is permission-based, never a
 * single broad role. Roles are bundles of these keys.
 */
export const ADMIN_PERMISSIONS = [
  'USERS_VIEW',
  'USERS_MANAGE',
  'VERIFICATION_VIEW',
  'VERIFICATION_REVIEW',
  'ERRANDS_VIEW',
  'ERRANDS_MODERATE',
  'REPORTS_VIEW',
  'REPORTS_MANAGE',
  'DISPUTES_VIEW',
  'DISPUTES_MANAGE',
  'ENFORCEMENT_APPLY',
  'RATINGS_MODERATE',
  'BLOCKLIST_MANAGE',
  'BILLING_VIEW',
  'REFUNDS_APPROVE',
  'SUBSCRIPTIONS_MANAGE',
  'BOOSTS_MANAGE',
  'PRICING_MANAGE',
  'CONFIG_VIEW',
  'CONFIG_MANAGE',
  'FEATURE_FLAGS_MANAGE',
  'REFERENCE_DATA_MANAGE',
  'NOTIFICATIONS_SEND',
  'OPS_VIEW',
  'OPS_MANAGE',
  'DSR_MANAGE',
  'AUDIT_VIEW',
  'AUDIT_EXPORT',
  'ANALYTICS_VIEW',
  'ANALYTICS_EXPORT',
  'SENSITIVE_DATA_VIEW',
  'LOCATION_EXACT_VIEW',
  'CHAT_SENSITIVE_VIEW',
  'ADMIN_ACCOUNTS_MANAGE',
] as const;

export type AdminPermissionKey = (typeof ADMIN_PERMISSIONS)[number];

/** Starting roles. SUPER_ADMIN holds every permission; the others are least-privilege bundles. */
export const DEFAULT_ADMIN_ROLES: Record<string, { description: string; permissions: readonly AdminPermissionKey[] }> = {
  SUPER_ADMIN: {
    description: 'Every permission. Creates the other admins.',
    permissions: ADMIN_PERMISSIONS,
  },
  SUPPORT_AGENT: {
    description: 'Looks up users and errands, handles reports.',
    permissions: ['USERS_VIEW', 'ERRANDS_VIEW', 'REPORTS_VIEW', 'REPORTS_MANAGE', 'DISPUTES_VIEW'],
  },
  TRUST_AND_SAFETY: {
    description: 'Verification review, moderation, enforcement and disputes.',
    permissions: [
      'USERS_VIEW',
      'USERS_MANAGE',
      'VERIFICATION_VIEW',
      'VERIFICATION_REVIEW',
      'ERRANDS_VIEW',
      'ERRANDS_MODERATE',
      'REPORTS_VIEW',
      'REPORTS_MANAGE',
      'DISPUTES_VIEW',
      'DISPUTES_MANAGE',
      'ENFORCEMENT_APPLY',
      'RATINGS_MODERATE',
      'BLOCKLIST_MANAGE',
    ],
  },
  FINANCE: {
    description: 'Billing, refunds, subscriptions, boosts and pricing.',
    permissions: ['BILLING_VIEW', 'REFUNDS_APPROVE', 'SUBSCRIPTIONS_MANAGE', 'BOOSTS_MANAGE', 'PRICING_MANAGE', 'ANALYTICS_VIEW'],
  },
  OPERATIONS: {
    description: 'Configuration, kill switches, reference data and operations tooling.',
    permissions: [
      'CONFIG_VIEW',
      'CONFIG_MANAGE',
      'FEATURE_FLAGS_MANAGE',
      'REFERENCE_DATA_MANAGE',
      'NOTIFICATIONS_SEND',
      'OPS_VIEW',
      'OPS_MANAGE',
      'AUDIT_VIEW',
      'ANALYTICS_VIEW',
    ],
  },
};
