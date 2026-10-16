import { Global, Module } from '@nestjs/common';
import { CursorService } from './pagination/cursor.service.js';
import { ClockService } from './utils/time.service.js';
import { GeographyService } from '../geography/geography.service.js';

/**
 * Shared providers every module can inject without importing this module.
 * Use ClockService (not `new Date()`) for anything time-dependent so tests can
 * control time.
 */
@Global()
@Module({
  providers: [ClockService, CursorService, GeographyService],
  exports: [ClockService, CursorService, GeographyService],
})
export class CommonModule {}
