/**
 * Pricing service (P1-02)
 * Handles price resolution with effectiveFrom dates
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export interface PriceVersion {
  id: string;
  productId: string;
  amountKobo: bigint; // Database returns BigInt
  currency: string;
  effectiveFrom: Date;
  notes: string | null;
  createdByAdminId: string | null;
  createdAt: Date;
}

export interface CommercialProduct {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: 'VERIFICATION_FEE' | 'RUNNER_PRO' | 'PRIORITY_BOOST';
  active: boolean;
  currentPrice?: PriceVersion;
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get current price for a product
   * Ignores future-dated prices
   */
  async getCurrentPrice(productId: string): Promise<PriceVersion | null> {
    const now = new Date();

    const result = await this.prisma.$queryRaw<PriceVersion[]>`
      SELECT 
        id, 
        product_id as "productId",
        amount_kobo as "amountKobo",
        currency,
        effective_from as "effectiveFrom",
        notes,
        created_by_admin_id as "createdByAdminId",
        created_at as "createdAt"
      FROM price_versions
      WHERE product_id = ${productId}::uuid
        AND effective_from <= ${now}
      ORDER BY effective_from DESC
      LIMIT 1
    `;

    return result.length > 0 ? result[0] : null;
  }

  /**
   * Get current price by product code
   */
  async getCurrentPriceByCode(code: string): Promise<PriceVersion | null> {
    const result = await this.prisma.$queryRaw<PriceVersion[]>`
      SELECT 
        pv.id, 
        pv.product_id as "productId",
        pv.amount_kobo as "amountKobo",
        pv.currency,
        pv.effective_from as "effectiveFrom",
        pv.notes,
        pv.created_by_admin_id as "createdByAdminId",
        pv.created_at as "createdAt"
      FROM price_versions pv
      JOIN commercial_products cp ON cp.id = pv.product_id
      WHERE cp.code = ${code}
        AND cp.active = true
        AND pv.effective_from <= NOW()
      ORDER BY pv.effective_from DESC
      LIMIT 1
    `;

    return result.length > 0 ? result[0] : null;
  }

  /**
   * Get price at a specific date (for historical orders)
   */
  async getPriceAt(productId: string, date: Date): Promise<PriceVersion | null> {
    const result = await this.prisma.$queryRaw<PriceVersion[]>`
      SELECT 
        id, 
        product_id as "productId",
        amount_kobo as "amountKobo",
        currency,
        effective_from as "effectiveFrom",
        notes,
        created_by_admin_id as "createdByAdminId",
        created_at as "createdAt"
      FROM price_versions
      WHERE product_id = ${productId}::uuid
        AND effective_from <= ${date}
      ORDER BY effective_from DESC
      LIMIT 1
    `;

    return result.length > 0 ? result[0] : null;
  }

  /**
   * Get all price versions for a product (for history/admin)
   */
  async getPriceHistory(productId: string): Promise<PriceVersion[]> {
    return this.prisma.$queryRaw<PriceVersion[]>`
      SELECT 
        id, 
        product_id as "productId",
        amount_kobo as "amountKobo",
        currency,
        effective_from as "effectiveFrom",
        notes,
        created_by_admin_id as "createdByAdminId",
        created_at as "createdAt"
      FROM price_versions
      WHERE product_id = ${productId}::uuid
      ORDER BY effective_from DESC
    `;
  }

  /**
   * Get all active products with their current prices
   */
  async getActiveProducts(): Promise<CommercialProduct[]> {
    const products = await this.prisma.$queryRaw<CommercialProduct[]>`
      SELECT 
        id,
        code,
        name,
        description,
        type,
        active,
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM commercial_products
      WHERE active = true
      ORDER BY name
    `;

    // Attach current prices
    for (const product of products) {
      product.currentPrice = await this.getCurrentPrice(product.id) || undefined;
    }

    return products;
  }

  /**
   * Create a new price version (admin only)
   */
  async createPriceVersion(
    productId: string,
    amountKobo: number,
    effectiveFrom: Date,
    notes?: string,
    createdByAdminId?: string,
  ): Promise<PriceVersion> {
    const result = await this.prisma.$queryRaw<PriceVersion[]>`
      INSERT INTO price_versions (
        product_id,
        amount_kobo,
        effective_from,
        notes,
        created_by_admin_id
      )
      VALUES (
        ${productId}::uuid,
        ${amountKobo},
        ${effectiveFrom},
        ${notes || null},
        ${createdByAdminId || null}::uuid
      )
      RETURNING 
        id, 
        product_id as "productId",
        amount_kobo as "amountKobo",
        currency,
        effective_from as "effectiveFrom",
        notes,
        created_by_admin_id as "createdByAdminId",
        created_at as "createdAt"
    `;

    return result[0];
  }
}
