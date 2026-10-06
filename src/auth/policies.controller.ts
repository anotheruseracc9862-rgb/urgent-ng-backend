import { Controller, Get, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { PolicyService } from './policy.service.js';

/**
 * Public Policies Controller (P2-07)
 * Public access to policy versions - no authentication required
 */
@Controller('policies')
export class PoliciesController {
  constructor(private readonly policyService: PolicyService) {}

  /**
   * Get current policy versions for all types
   * GET /policies/current
   * Public endpoint
   */
  @Get('current')
  @HttpCode(HttpStatus.OK)
  async getCurrentPolicies() {
    const policies = await this.policyService.getCurrentPolicies();
    return {
      success: true,
      data: policies,
    };
  }

  /**
   * Get a specific policy version by ID
   * GET /policies/versions/:id
   * Public endpoint
   */
  @Get('versions/:id')
  @HttpCode(HttpStatus.OK)
  async getPolicyVersion(@Param('id') id: string) {
    const policy = await this.policyService.getPolicyVersion(id);
    return {
      success: true,
      data: policy,
    };
  }

  /**
   * Get all versions of a specific policy type
   * GET /policies/:type/versions
   * Public endpoint
   */
  @Get(':type/versions')
  @HttpCode(HttpStatus.OK)
  async getPolicyVersionsByType(@Param('type') type: string) {
    const policies = await this.policyService.getPolicyVersionsByType(type as any);
    return {
      success: true,
      data: policies,
    };
  }
}
