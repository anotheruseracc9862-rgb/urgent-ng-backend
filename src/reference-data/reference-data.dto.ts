import { ApiProperty } from '@nestjs/swagger';

export class ServiceLgaDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  name!: string;
}

export class ServiceStateDto extends ServiceLgaDto {
  @ApiProperty({ type: [ServiceLgaDto] })
  lgas!: ServiceLgaDto[];
}

export class ServiceAreasDto {
  @ApiProperty({ type: [ServiceStateDto] })
  states!: ServiceStateDto[];
  @ApiProperty()
  interstateEnabled!: boolean;
}

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
