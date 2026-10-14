import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export interface CategoryView {
  id: string;
  key: string;
  name: string;
  requiresPickup: boolean;
  requiresDestination: boolean;
  isPopular: boolean;
}

export interface ProhibitedItemView {
  category: string;
  keyword: string;
  description: string | null;
  policyVersion: string;
}

/**
 * Reference data (Backend PRD 11.2, 11.9, A.5). Admin-editable later; read-only here.
 * Soft-deleted and inactive rows are never returned. `effective_from` is compared with
 * the database clock.
 */
@Injectable()
export class ReferenceDataService {
  constructor(private readonly prisma: PrismaService) {}

  async categories(options: { popularOnly?: boolean } = {}): Promise<CategoryView[]> {
    const rows = await this.prisma.client.category.findMany({
      where: { active: true, ...(options.popularOnly ? { isPopular: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      requiresPickup: row.requiresPickup,
      requiresDestination: row.requiresDestination,
      isPopular: row.isPopular,
    }));
  }

  async prohibitedItems(): Promise<ProhibitedItemView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ category: string; keyword: string; description: string | null; policy_version: string }>
    >`
      SELECT category, keyword, description, policy_version
      FROM prohibited_item_rules
      WHERE deleted_at IS NULL AND status = 'ACTIVE' AND effective_from <= now()
      ORDER BY category, keyword
    `;
    return rows.map((row) => ({
      category: row.category,
      keyword: row.keyword,
      description: row.description,
      policyVersion: row.policy_version,
    }));
  }
}
