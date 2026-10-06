import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditService } from './audit.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
