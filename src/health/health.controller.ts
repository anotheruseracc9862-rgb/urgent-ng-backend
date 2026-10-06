import { Controller, Get, Inject } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { REDIS_CLIENT } from '../common/redis/redis.module.js';
import { QUEUE_NAMES } from '../queue/queue.registry.js';

const CHECK_TIMEOUT_MS = 2000;

/**
 * Health check controller (P1-09)
 * Implements liveness and readiness probes per PRD §28.3.
 *
 * - /health/live: liveness (is the process alive?). No dependencies.
 * - /health/ready: readiness (database, Redis and queues reachable?).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      async () => this.indicator.check('process').up({ uptime: process.uptime() }),
    ]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () =>
        this.indicator
          .check('database')
          .attempt(async () => {
            await this.prisma.$queryRaw`SELECT 1`;
          })
          .withTimeout(CHECK_TIMEOUT_MS),

      () =>
        this.indicator
          .check('redis')
          .attempt(async () => {
            await this.redis.ping();
          })
          .withTimeout(CHECK_TIMEOUT_MS),

      // Queues: reachable, and report how many jobs are waiting or failed.
      () =>
        this.indicator
          .check('queue')
          .attempt(async () => {
            const depths: Record<string, { waiting: number; failed: number }> = {};
            for (const name of Object.values(QUEUE_NAMES)) {
              const queue = this.moduleRef.get<Queue>(getQueueToken(name), {
                strict: false,
              });
              const counts = await queue.getJobCounts('waiting', 'failed');
              depths[name] = { waiting: counts.waiting ?? 0, failed: counts.failed ?? 0 };
            }
            return { depths };
          })
          .withTimeout(CHECK_TIMEOUT_MS),
    ]);
  }

  /**
   * Same as /health/ready (kept so a plain /health keeps working).
   */
  @Get()
  @HealthCheck()
  check() {
    return this.readiness();
  }
}
