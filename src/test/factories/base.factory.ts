/**
 * Base factory class for test data generation
 */

import { PrismaClient } from '@prisma/client';
import { getTestPrisma } from '../database.helper.js';

export abstract class BaseFactory<T, TCreateInput = Partial<T>> {
  protected prisma: PrismaClient;

  constructor() {
    this.prisma = getTestPrisma();
  }

  /**
   * Build an entity with default + override attributes (doesn't persist)
   */
  abstract build(attributes?: TCreateInput): T;

  /**
   * Create and persist an entity to the database
   */
  abstract create(attributes?: TCreateInput): Promise<T>;

  /**
   * Create multiple entities
   */
  async createMany(count: number, attributes?: TCreateInput): Promise<T[]> {
    const promises = Array.from({ length: count }, () => this.create(attributes));
    return Promise.all(promises);
  }
}
