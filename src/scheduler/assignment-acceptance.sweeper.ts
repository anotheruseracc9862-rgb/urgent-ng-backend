import { Injectable } from '@nestjs/common';
import { BaseSweeper } from './base-sweeper.js';
import { PrismaService } from '../database/prisma.service.js';
import { AssignmentService } from '../assignments/assignment.service.js';

/** Times out pending assignments whose acceptance deadline has passed (Backend PRD 14.4, 25.3). */
@Injectable()
export class AssignmentAcceptanceSweeper extends BaseSweeper {
  constructor(
    prisma: PrismaService,
    private readonly assignments: AssignmentService,
  ) {
    super(prisma, 'AssignmentAcceptanceSweeper');
  }

  protected async processBatch(): Promise<number> {
    return this.assignments.expireDue();
  }
}
