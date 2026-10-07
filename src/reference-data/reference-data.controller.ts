import { ApiTags } from '@nestjs/swagger';
import { ApiEnveloped, ApiErrors } from '../common/api/api-docs.js';
import { CategoryDto, ProhibitedItemDto } from './reference-data.dto.js';
import { PolicyVersionDto } from '../auth/dto/responses.dto.js';
import { Controller, Get, Param, ParseEnumPipe } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { PolicyService } from '../auth/policy.service.js';
import { DomainException } from '../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../common/constants/error-codes.js';
import { ReferenceDataService } from './reference-data.service.js';

/** Public reference data (Backend PRD 30.6). No authentication. */
@ApiTags('Reference')
@Controller('reference')
export class ReferenceDataController {
  constructor(
    private readonly reference: ReferenceDataService,
    private readonly policies: PolicyService,
  ) {}

  @Get('categories')
  @ApiEnveloped(CategoryDto, { isArray: true })
  categories() {
    return this.reference.categories();
  }

  @Get('popular-categories')
  @ApiEnveloped(CategoryDto, { isArray: true })
  popularCategories() {
    return this.reference.categories({ popularOnly: true });
  }

  @Get('prohibited-items')
  @ApiEnveloped(ProhibitedItemDto, { isArray: true })
  prohibitedItems() {
    return this.reference.prohibitedItems();
  }

  /** Every current policy (latest published version of each type). */
  @Get('policies')
  @ApiEnveloped(PolicyVersionDto, { isArray: true })
  currentPolicies() {
    return this.policies.current();
  }

  /** The current published version of one policy type. */
  @Get('policies/:type')
  @ApiEnveloped(PolicyVersionDto)
  @ApiErrors(404)
  async policy(@Param('type', new ParseEnumPipe(ConsentType)) type: ConsentType) {
    const current = (await this.policies.current()).find((policy) => policy.type === type);
    if (!current) {
      throw DomainException.of(RESOURCE_NOT_FOUND);
    }
    return current;
  }
}
