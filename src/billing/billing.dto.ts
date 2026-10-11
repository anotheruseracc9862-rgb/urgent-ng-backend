import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination/pagination.dto.js';

export const PURCHASABLE_TYPES = ['RUNNER_PRO', 'VERIFICATION_FEE'] as const;

/** `POST /billing/orders`. A boost has its own route (`POST /boosts`), where the errand is the point. */
export class CreateOrderDto {
  @ApiProperty({ enum: PURCHASABLE_TYPES })
  @IsIn(PURCHASABLE_TYPES as unknown as string[])
  type!: (typeof PURCHASABLE_TYPES)[number];

  @ApiPropertyOptional({ description: 'Runner Pro: renew automatically with the card used for this payment.' })
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;
}

export class CreateBoostDto {
  @ApiProperty({ description: 'The open errand to boost. You must be its requester.' })
  @IsUUID()
  errandId!: string;
}

export class OrderListQueryDto extends PaginationQueryDto {}

export class ProductDto {
  @ApiProperty({ example: 'RUNNER_PRO' })
  code!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty({ enum: ['VERIFICATION_FEE', 'RUNNER_PRO', 'BOOST'], description: 'The order type that buys this product.' })
  orderType!: string;
  @ApiProperty({ description: 'The price in kobo, VAT included.' })
  priceMinor!: number;
  @ApiProperty({ description: 'The VAT inside that price, in kobo.' })
  vatMinor!: number;
  @ApiProperty()
  currency!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'How long it lasts, in days, where that applies.' })
  periodDays!: number | null;
}

export class OrderPaymentDto {
  @ApiProperty()
  reference!: string;
  @ApiProperty({ enum: ['INITIATED', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] })
  status!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Where the customer pays. Null once paid or failed.' })
  authorizationUrl!: string | null;
}

export class OrderDto {
  @ApiProperty()
  id!: string;
  @ApiProperty({ enum: ['VERIFICATION_FEE', 'RUNNER_PRO', 'BOOST'] })
  type!: string;
  @ApiProperty({ enum: ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'] })
  status!: string;
  @ApiProperty({ description: 'Kobo, VAT included.' })
  amountMinor!: number;
  @ApiProperty({ description: 'The VAT inside the amount, in kobo.' })
  vatMinor!: number;
  @ApiProperty()
  currency!: string;
  @ApiProperty({ type: String, nullable: true })
  errandId!: string | null;
  @ApiProperty({ type: OrderPaymentDto, nullable: true })
  payment!: OrderPaymentDto | null;
  @ApiProperty({ type: Date, nullable: true })
  paidAt!: Date | null;
  @ApiProperty({ type: Date })
  createdAt!: Date;
}

export class ProSubscriptionDto {
  @ApiProperty({ description: 'The runner has Pro benefits right now.' })
  active!: boolean;
  @ApiProperty({ enum: ['NONE', 'TRIAL', 'ACTIVE', 'PENDING_RENEWAL', 'PAYMENT_FAILED', 'GRACE_PERIOD', 'CANCELLED', 'EXPIRED'] })
  status!: string;
  @ApiProperty({ type: Date, nullable: true })
  currentPeriodEnd!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'During a failed renewal: when benefits end if it is not paid.' })
  graceEndsAt!: Date | null;
  @ApiProperty()
  autoRenew!: boolean;
  @ApiProperty({ type: Date, nullable: true })
  cancelledAt!: Date | null;
}

export class WebhookAckDto {
  @ApiProperty()
  received!: boolean;
  @ApiProperty({ enum: ['processed', 'duplicate', 'ignored'] })
  result!: string;
}
