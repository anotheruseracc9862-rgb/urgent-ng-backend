import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Reason codes for admin writes (Backend PRD 24.5). Every admin write carries one of these plus
 * optional free text, and both are audited. The list is closed on purpose: a report can group by it.
 */
export const ADMIN_REASON_CODES = [
  'POLICY_VIOLATION',
  'SAFETY_RISK',
  'FRAUD_SUSPECTED',
  'USER_REQUEST',
  'SUPPORT_CORRECTION',
  'DATA_ERROR',
  'LEGAL_REQUEST',
  'SYSTEM_FAULT',
  'FINANCE_ADJUSTMENT',
  'APPEAL_OUTCOME',
  'ROUTINE_OPERATION',
  'OTHER',
] as const;

export type AdminReasonCode = (typeof ADMIN_REASON_CODES)[number];

/** Codes for which the free text is required: "other" says nothing by itself. */
export const REASON_TEXT_REQUIRED: readonly AdminReasonCode[] = ['OTHER'];

/**
 * The reason block every admin write body carries. Extend it for the action's own fields:
 *
 *   class SuspendDto extends AdminActionDto { @IsInt() days!: number }
 */
export class AdminActionDto {
  @ApiProperty({ enum: ADMIN_REASON_CODES, description: 'Why. Audited with the action.' })
  @IsIn(ADMIN_REASON_CODES as unknown as string[])
  reasonCode!: AdminReasonCode;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Free text for the audit record. Required when the code is OTHER.' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reasonText?: string;
}

export interface AdminReason {
  code: AdminReasonCode;
  text?: string;
}
