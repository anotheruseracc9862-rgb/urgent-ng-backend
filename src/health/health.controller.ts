import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Health check controller (P1-09)
 * Implements liveness and readiness probes per PRD §28.3.
 * 
 * - /health/live: Liveness probe (should the container be restarted?)
 * - /health/ready: Readiness probe (should traffic be routed to this instance?)
 */
@Controller('health')
export class HealthController {
  private redis: Redis;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Create Redis client for health checks
    this.redis = new Redis(this.config.getOrThrow<string>('redis.url'), {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
  }

  /**
   * Liveness probe
   * Checks if the application is alive (not deadlocked).
   * Kubernetes will restart the pod if this fails.
   * 
   * Only checks internal health, not dependencies.
   */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        // Simple check: can we allocate memory and respond?
        return { process: { status: 'up', uptime: process.uptime() } };
      },
    ]);
  }

  /**
   * Readiness probe
   * Checks if the application is ready to serve traffic.
   * Kubernetes will not route traffic if this fails, but won't restart.
   * 
   * Checks all critical dependencies: database, Redis, queue.
   */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      // Database check
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
          return { database: { status: 'up' } };
        } catch (error) {
          return {
            database: {
              status: 'down',
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },

      // Redis check
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.redis.ping();
          return { redis: { status: 'up' } };
        } catch (error) {
          return {
            redis: {
              status: 'down',
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },

      // Queue health (BullMQ uses Redis, so this checks queue connectivity)
      async (): Promise<HealthIndicatorResult> => {
        try {
          // Simple check: can we connect to Redis for queues?
          const info = await this.redis.info('server');
          return {
            queue: {
              status: 'up',
              redis_version: info.split('\r\n').find((line: string) => line.startsWith('redis_version'))?.split(':')[1] || 'unknown',
            },
          };
        } catch (error) {
          return {
            queue: {
              status: 'down',
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    ]);
  }

  /**
   * Legacy health endpoint (for backward compatibility)
   * Use /health/ready for new deployments
   */
  @Get()
  @HealthCheck()
  check() {
    return this.readiness();
  }
}

