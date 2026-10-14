import { ApiProperty } from '@nestjs/swagger';

export class CategoryDto {
  id!: string;
  /** Stable key, for example `delivery`. */
  key!: string;
  name!: string;
  requiresPickup!: boolean;
  requiresDestination!: boolean;
  isPopular!: boolean;
}

export class ProhibitedItemDto {
  category!: string;
  keyword!: string;
  @ApiProperty({ nullable: true })
  description!: string | null;
  policyVersion!: string;
}
