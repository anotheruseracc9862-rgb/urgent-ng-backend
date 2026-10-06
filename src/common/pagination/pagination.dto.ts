import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor for pagination',
    example: 'eyJwYXlsb2FkIjoie1wic29ydFwiOjEwMCxcImNyZWF0ZWRBdFwiOlwiMjAyNC0wMS0wMVQwMDowMDowMC4wMDBaXCIsXCJpZFwiOlwiMTIzNDU2Nzg5MFwifSIsInNpZ25hdHVyZSI6ImFiY2RlZiJ9',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    hasMore: boolean;
    nextCursor?: string;
  };
}
