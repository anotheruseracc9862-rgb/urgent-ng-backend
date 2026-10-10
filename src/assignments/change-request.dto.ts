import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject } from 'class-validator';

const TYPES = ['AMOUNT', 'PICKUP', 'DESTINATION', 'TIME', 'OTHER'] as const;

export class CreateChangeRequestDto {
  @ApiProperty({ enum: TYPES })
  @IsIn(TYPES as unknown as string[])
  type!: (typeof TYPES)[number];

  @ApiProperty({
    type: Object,
    description:
      'AMOUNT { amountMinor }. PICKUP or DESTINATION { point: { lat, lng }, addressText?, landmark? }. TIME { scheduledAt } (scheduled errands only). OTHER { note }.',
  })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class ChangeRequestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  assignmentId!: string;

  @ApiProperty()
  requestedBy!: string;

  @ApiProperty({ enum: TYPES })
  type!: string;

  @ApiProperty({ type: Object })
  payload!: Record<string, unknown>;

  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'] })
  status!: string;

  @ApiProperty({ nullable: true })
  respondedBy!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  respondedAt!: Date | null;

  @ApiProperty({ type: Date, description: 'The other party must answer before this time, or when the item is picked up, whichever is first.' })
  expiresAt!: Date;

  @ApiProperty({ type: Date })
  createdAt!: Date;
}
