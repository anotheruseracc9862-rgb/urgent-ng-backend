import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { MediaAccessService } from '../media/media-access.service.js';

/**
 * Who besides the uploader may view dispute evidence (Backend PRD 23.4): the requester and the
 * runner of the assignment the dispute is about, once the file is attached to it. A file that is
 * not attached to a dispute belongs to its uploader alone; report evidence is for its reporter
 * (the uploader) and admins.
 */
@Injectable()
export class DisputeMediaAccess implements OnModuleInit {
  constructor(
    private readonly access: MediaAccessService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.access.register({
      purposes: ['DISPUTE_EVIDENCE'],
      canView: async (media, viewerId) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT d.id::text
          FROM evidence_links el
          JOIN disputes d ON d.id = el.dispute_id AND d.deleted_at IS NULL
          JOIN assignments a ON a.id = d.assignment_id
          WHERE el.source_type = 'MEDIA'::"EvidenceSourceType" AND el.source_id = ${media.id}::uuid
            AND (a.requester_id = ${viewerId}::uuid OR a.runner_id = ${viewerId}::uuid)
          LIMIT 1
        `;
        return rows.length > 0;
      },
    });
  }
}
