import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { MediaAccessService } from '../media/media-access.service.js';
import { EXECUTION_EVIDENCE_PURPOSES } from './execution-details.service.js';

/**
 * Who besides the runner who uploaded it may view execution evidence (Backend PRD 23.4): the
 * requester and the runner of the assignment the photo belongs to. A photo that is not attached to
 * any step belongs to nobody else. Dispute evidence follows in Phase 9.
 */
@Injectable()
export class ExecutionMediaAccess implements OnModuleInit {
  constructor(
    private readonly access: MediaAccessService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.access.register({
      purposes: EXECUTION_EVIDENCE_PURPOSES,
      canView: async (media, viewerId) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT a.id::text FROM assignments a
          WHERE a.deleted_at IS NULL
            AND (a.requester_id = ${viewerId}::uuid OR a.runner_id = ${viewerId}::uuid)
            AND a.id IN (
              SELECT assignment_id FROM execution_events WHERE media_id = ${media.id}::uuid
              UNION SELECT assignment_id FROM checkpoints WHERE media_id = ${media.id}::uuid
              UNION SELECT assignment_id FROM execution_problems WHERE media_id = ${media.id}::uuid
            )
          LIMIT 1
        `;
        return rows.length > 0;
      },
    });
  }
}
