import { Injectable } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';

export interface PolicyVersionView {
  id: string;
  type: ConsentType;
  version: string;
  documentRef: string;
  publishedAt: Date;
  requiresReacceptance: boolean;
}

interface PolicyRow {
  id: string;
  type: ConsentType;
  version: string;
  document_ref: string;
  published_at: Date;
  requires_reacceptance: boolean;
}

const toView = (row: PolicyRow): PolicyVersionView => ({
  id: row.id,
  type: row.type,
  version: row.version,
  documentRef: row.document_ref,
  publishedAt: row.published_at,
  requiresReacceptance: row.requires_reacceptance,
});

/**
 * Policy versions (Backend PRD 9.6). A version is visible once `published_at` has
 * passed (database clock). Publishing a new version can require re-acceptance.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin: publish a new version. The (type, version) pair is unique. */
  async publish(
    type: ConsentType,
    version: string,
    documentRef: string,
    options: { publishedAt?: Date; requiresReacceptance?: boolean } = {},
  ): Promise<PolicyVersionView> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      INSERT INTO policy_versions (type, version, document_ref, published_at, requires_reacceptance)
      VALUES (
        ${type}::"ConsentType", ${version}, ${documentRef},
        COALESCE(${options.publishedAt ?? null}::timestamptz, date_trunc('milliseconds', now())),
        ${options.requiresReacceptance ?? false}
      )
      ON CONFLICT (type, version) DO NOTHING
      RETURNING id, type::text AS type, version, document_ref, published_at, requires_reacceptance
    `;
    if (rows.length === 0) {
      throw DomainException.of(RESOURCE_CONFLICT, {
        message: `Policy version ${version} already exists for ${type}.`,
      });
    }
    return toView(rows[0]);
  }

  /** The latest published version of each policy type. */
  async current(): Promise<PolicyVersionView[]> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      SELECT DISTINCT ON (type) id, type::text AS type, version, document_ref, published_at, requires_reacceptance
      FROM policy_versions
      WHERE published_at <= now()
      ORDER BY type, published_at DESC, created_at DESC
    `;
    return rows.map(toView);
  }

  /** A specific published version, or null when it does not exist or is not live yet. */
  async findPublished(type: ConsentType, version: string): Promise<PolicyVersionView | null> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      SELECT id, type::text AS type, version, document_ref, published_at, requires_reacceptance
      FROM policy_versions
      WHERE type = ${type}::"ConsentType" AND version = ${version} AND published_at <= now()
    `;
    return rows[0] ? toView(rows[0]) : null;
  }

  async getPublished(id: string): Promise<PolicyVersionView> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      SELECT id, type::text AS type, version, document_ref, published_at, requires_reacceptance
      FROM policy_versions WHERE id = ${id}::uuid AND published_at <= now()
    `;
    if (!rows[0]) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return toView(rows[0]);
  }

  async history(type: ConsentType): Promise<PolicyVersionView[]> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      SELECT id, type::text AS type, version, document_ref, published_at, requires_reacceptance
      FROM policy_versions
      WHERE type = ${type}::"ConsentType" AND published_at <= now()
      ORDER BY published_at DESC, created_at DESC
    `;
    return rows.map(toView);
  }

  /**
   * Policy types whose current version this user still has to accept: no
   * (un-withdrawn) acceptance at all, or an older version while the current one
   * requires re-acceptance. MARKETING_COMMUNICATIONS and LOCATION_SHARING are
   * optional and never block the user.
   */
  async outstandingFor(userId: string): Promise<PolicyVersionView[]> {
    const rows = await this.prisma.$queryRaw<PolicyRow[]>`
      WITH current AS (
        SELECT DISTINCT ON (type) id, type, version, document_ref, published_at, requires_reacceptance
        FROM policy_versions
        WHERE published_at <= now()
        ORDER BY type, published_at DESC, created_at DESC
      )
      SELECT c.id, c.type::text AS type, c.version, c.document_ref, c.published_at, c.requires_reacceptance
      FROM current c
      WHERE c.type NOT IN ('MARKETING_COMMUNICATIONS'::"ConsentType", 'LOCATION_SHARING'::"ConsentType")
        AND NOT EXISTS (
          SELECT 1 FROM consent_records r
          WHERE r.user_id = ${userId}::uuid
            AND r.consent_type = c.type
            AND r.withdrawn_at IS NULL
            AND (r.document_version = c.version OR NOT c.requires_reacceptance)
        )
    `;
    return rows.map(toView);
  }
}
