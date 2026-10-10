import { Module } from '@nestjs/common';
import { AssignmentService } from './assignment.service.js';

@Module({
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentsModule {}
