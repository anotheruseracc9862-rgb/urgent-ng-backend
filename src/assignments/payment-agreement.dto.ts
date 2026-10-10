import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

const METHODS = ['CASH', 'BANK_TRANSFER', 'MOBILE_TRANSFER', 'OTHER'] as const;
const TIMINGS = ['BEFORE_PICKUP', 'AT_PICKUP', 'AFTER_PICKUP', 'AT_DELIVERY', 'AFTER_DELIVERY', 'OTHER'] as const;

/**
 * What the two parties say they agreed (Backend PRD 16.1). The amount is the runner's service fee,
 * fixed at selection, and changes only through an accepted change request: it is not a field here.
 */
export class UpdatePaymentAgreementDto {
  @ApiPropertyOptional({ enum: METHODS })
  @IsOptional()
  @IsIn(METHODS as unknown as string[])
  paymentMethod?: (typeof METHODS)[number];

  @ApiPropertyOptional({ enum: TIMINGS })
  @IsOptional()
  @IsIn(TIMINGS as unknown as string[])
  paymentTiming?: (typeof TIMINGS)[number];

  @ApiPropertyOptional({
    description:
      'Confirm the terms as they now stand. Needs both a method and a timing. Changing the method or timing first clears both confirmations, then this confirms for the caller.',
  })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class PaymentAgreementDto {
  @ApiProperty()
  assignmentId!: string;

  @ApiProperty({ description: 'The runner fee in kobo. A record of what was agreed, never money held by Urgent.ng.' })
  agreedAmountMinor!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: METHODS, nullable: true })
  paymentMethod!: string | null;

  @ApiProperty({ enum: TIMINGS, nullable: true })
  paymentTiming!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  confirmedByRequesterAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  confirmedByRunnerAt!: Date | null;

  @ApiProperty({ description: 'Both parties confirmed the current terms.' })
  fullyConfirmed!: boolean;
}
