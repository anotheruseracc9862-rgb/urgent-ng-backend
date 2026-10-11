import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RunnerLocationController } from './runner-location.controller.js';
import { RunnerLocationService } from './runner-location.service.js';

/**
 * The runner's shared location while an errand is active (Backend PRD 17.3, 17.4). The maps
 * provider comes from the global ProvidersModule.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigStoreModule, DatabaseModule, QueueModule],
  controllers: [RunnerLocationController],
  providers: [RunnerLocationService],
  exports: [RunnerLocationService],
})
export class LocationsModule {}
