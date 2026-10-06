import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * Idempotency service (P1-05)
 * Prevents duplicate business effects from retry or network issues
 * Per PRD §6.4
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if an idempotency key exists and return the stored response if available.
   * Returns null if the key doesn't exist.
   * Throws IdempotencyConflictError if the key exists with a different request body.
   */
  async check(
    userId: string,
    operation: string,
    key: string,
    requestBody: unknown,
  ): Promise<{
    responseStatus: number | null;
    responseBody: any | null;
  } | null> {
    const requestHash = this.hashRequest(requestBody);

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        userId_operation_key: {
          userId,
          operation,
          key,
        },
      },
    });

    if (!existing) {
      return null;
    }

    // Verify request body matches
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        'Idempotency key already used with different request body',
      );
    }

    return {
      responseStatus: existing.responseStatus,
      responseBody: existing.responseBody,
    };
  }

  /**
   * Store a new idempotency key before processing the request.
   * Returns true if stored successfully, false if key already exists.
   */
  async store(
    userId: string,
    operation: string,
    key: string,
    requestBody: unknown,
  ): Promise<boolean> {
    const requestHash = this.hashRequest(requestBody);

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          userId,
          operation,
          key,
          requestHash,
          responseStatus: null,
          responseBody: Prisma.DbNull,
        },
      });
      return true;
    } catch (error) {
      // Unique constraint violation means key already exists
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Update an idempotency key with the response after successful processing.
   */
  async updateResponse(
    userId: string,
    operation: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: {
        userId_operation_key: {
          userId,
          operation,
          key,
        },
      },
      data: {
        responseStatus: status,
        responseBody: body as any,
      },
    });
  }

  /**
   * Clean up old idempotency keys.
   * Should be called by a scheduled sweeper (P1-06).
   * Returns the number of deleted records.
   */
  async cleanup(ttlHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);

    const result = await this.prisma.idempotencyKey.deleteMany({
      where: {
        createdAt: {
          lt: cutoff,
        },
      },
    });

    return result.count;
  }

  /**
   * Hash request body for comparison.
   * Uses deterministic JSON serialization.
   */
  private hashRequest(body: unknown): string {
    if (body === null || body === undefined) {
      return createHash('sha256').update('null').digest('hex');
    }

    // Sort keys for deterministic hashing
    const normalized = JSON.stringify(
      body,
      Object.keys(body as object).sort(),
    );
    return createHash('sha256').update(normalized).digest('hex');
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}
