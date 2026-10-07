import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { IdempotencyModule } from '../common/idempotency/idempotency.module.js';
import { AdminMediaController, MediaController, ProfilePhotoController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaProcessingService } from './media-processing.service.js';
import { MediaAccessService } from './media-access.service.js';
import { MediaCleanupService } from './media-cleanup.service.js';
import { ProfilePhotoService } from './profile-photo.service.js';
import { MediaWorker } from './media.worker.js';
import { MEDIA_MODERATION_HOOK, NoopModerationHook } from './moderation.hook.js';

/**
 * Media and storage (Backend PRD section 23): presigned uploads, processing, purpose-scoped
 * downloads and cleanup. Other modules attach media by id through MediaService and register a
 * MediaAccessPolicy on MediaAccessService for the purposes they own.
 */
@Module({
  imports: [AuthModule, AdminModule, AuditModule, ConfigStoreModule, QueueModule, IdempotencyModule],
  controllers: [MediaController, ProfilePhotoController, AdminMediaController],
  providers: [
    MediaService,
    MediaProcessingService,
    MediaAccessService,
    MediaCleanupService,
    ProfilePhotoService,
    MediaWorker,
    { provide: MEDIA_MODERATION_HOOK, useClass: NoopModerationHook },
  ],
  exports: [MediaService, MediaAccessService, MediaCleanupService, MediaWorker, MEDIA_MODERATION_HOOK],
})
export class MediaModule {}
