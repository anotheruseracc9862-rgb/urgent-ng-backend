import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { softDeleteExtension } from './soft-delete.extension.js';

/**
 * Database client for the API, workers and scheduler (one DATABASE_URL).
 *
 * - `client` is the same connection with soft deletion applied (see
 *   soft-delete.extension.ts). Repositories use `prisma.client` for models
 *   that have a `deletedAt` column; raw SQL and transactional helpers can use
 *   the service itself.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /** This connection with soft deletion applied to every soft-deletable model. */
  readonly client = this.$extends(softDeleteExtension);

  constructor(private readonly config: ConfigService) {
    super({
      datasourceUrl: config.getOrThrow<string>('database.url'),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
