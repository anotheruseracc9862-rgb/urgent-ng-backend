import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type MediaPurpose } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { MediaAccessService } from '../media/media-access.service.js';
import { RunnerEligibilityService } from '../runner/runner-eligibility.service.js';
import { openErrandVisibleTo } from './marketplace-feed.service.js';

/**
 * Who besides the owner may view an ERRAND_PHOTO (Backend PRD 23.4): a runner who can browse the feed
 * and could see that errand in it. Anyone else gets "not found". Once an errand is no longer open its
 * photos are the owner's again (the assignment module adds the assigned runner in Phase 7).
 *
 * Profile photos already have their own rule (any signed-in user while the photo is current), so
 * this policy does not touch them: a purpose has one policy, and registering another would replace it.
 */
@Injectable()
export class MarketplaceMediaAccess implements OnModuleInit {
  constructor(
    private readonly access: MediaAccessService,
    private readonly prisma: PrismaService,
    private readonly eligibility: RunnerEligibilityService,
  ) {}

  onModuleInit(): void {
    const purposes: MediaPurpose[] = ['ERRAND_PHOTO'];
    this.access.register({
      purposes,
      canView: async (media, viewerId) => {
        // The runner of an assignment on the errand (pending, accepted or completed): the photos are
        // non-sensitive, they stay part of the runner's task history, and the errand is no longer open
        // so the feed rule below would refuse.
        const assigned = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT a.id::text FROM assignments a
          WHERE a.runner_id = ${viewerId}::uuid AND a.deleted_at IS NULL
            AND a.status IN ('PENDING_ACCEPTANCE'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus", 'COMPLETED'::"AssignmentStatus")
            AND a.errand_id IN (SELECT errand_id FROM errand_media WHERE media_id = ${media.id}::uuid AND deleted_at IS NULL)
          LIMIT 1
        `);
        if (assigned.length > 0) {
          return true;
        }
        if (!(await this.eligibility.canBrowseFeed(viewerId)).allowed) {
          return false;
        }
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT e.id::text FROM errands e
          WHERE e.id IN (SELECT errand_id FROM errand_media WHERE media_id = ${media.id}::uuid AND deleted_at IS NULL)
            AND ${openErrandVisibleTo(viewerId)}
          LIMIT 1
        `);
        return rows.length > 0;
      },
    });
  }
}
