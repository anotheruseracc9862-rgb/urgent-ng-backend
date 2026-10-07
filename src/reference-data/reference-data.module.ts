import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReferenceDataController } from './reference-data.controller.js';
import { ReferenceDataService } from './reference-data.service.js';

@Module({
  imports: [AuthModule], // PolicyService
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService],
  exports: [ReferenceDataService],
})
export class ReferenceDataModule {}
