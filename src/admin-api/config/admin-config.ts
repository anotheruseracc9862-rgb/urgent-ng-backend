import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { BusinessConfigService } from '../../config/business-config.service.js';
import { PricingService } from '../../config/pricing.service.js';
import { PolicyService } from '../../auth/policy.service.js';
import { TEMPLATE_DEFAULTS } from '../../notifications/notification-templates.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_CONFLICT, RESOURCE_NOT_FOUND, VALIDATION_ERROR } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { AdminActionDto } from '../../admin/framework/admin-reasons.js';
import { ApprovalService } from '../../admin/framework/approval.service.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

// ---- What needs a second admin (Backend PRD 24.5) ----

const HIGH_IMPACT_KEYS = new Set([
  'FREE_RUNNER_DAILY_OFFER_LIMIT',
  'PRO_DAILY_OFFER_CAP',
  'VERIFICATION_FEE',
  'REFUND_FOUR_EYES_THRESHOLD',
]);

/** A config key whose change a second admin must approve: kill switches, prices, ladder thresholds, offer limits. */
export function approvalKindFor(key: string): 'KILL_SWITCH' | 'PRICE_CHANGE' | 'CONFIG_CHANGE' | null {
  if (key.startsWith('FEATURE_')) return 'KILL_SWITCH';
  if (key.endsWith('_PRICE') || key === 'VERIFICATION_FEE') return 'PRICE_CHANGE';
  if (key.startsWith('LADDER_') || HIGH_IMPACT_KEYS.has(key)) return 'CONFIG_CHANGE';
  return null;
}

function groupOf(key: string): string {
  if (key.startsWith('FEATURE_')) return 'Kill switches';
  if (key.startsWith('LADDER_') || key.startsWith('RELIABILITY_') || key.startsWith('NO_SHOW_')) return 'Trust and safety';
  if (key.startsWith('BADGE_') || key.endsWith('_WINDOW')) return 'Badges and windows';
  if (key.startsWith('OTP_') || key.startsWith('LOGIN_') || key.startsWith('KYC_') || key.startsWith('VERIFICATION_')) return 'Identity and security';
  if (key.endsWith('_PRICE') || key.startsWith('RUNNER_PRO') || key.startsWith('PRIORITY_BOOST') || key.startsWith('REFUND_') || key === 'VAT_RATE') return 'Commercial';
  if (key.startsWith('RATE_') || key.startsWith('MEDIA_') || key.startsWith('MAX_')) return 'Limits';
  if (key.startsWith('RISK_') || key.startsWith('DISPUTE_') || key.startsWith('REPORT_') || key.startsWith('APPEAL_')) return 'Cases and risk';
  if (key.startsWith('OFFER_') || key.includes('OFFER')) return 'Offers';
  if (key.includes('ERRAND') || key.startsWith('SCHEDULED_') || key.startsWith('ASSIGNMENT_') || key.startsWith('DELIVERY_')) return 'Errands and assignments';
  return 'General';
}

// ---- DTOs ----

export class SetConfigDto extends AdminActionDto {
  @ApiProperty({ description: 'The new value. Its type must match the key (number, boolean or string).' })
  @IsDefined()
  value!: number | boolean | string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'When it starts to apply. Leave out for now.' })
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;
}

export class SetFlagDto extends AdminActionDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}

export class SetPriceDto extends AdminActionDto {
  @ApiProperty({ description: 'Kobo, VAT inclusive. Zero makes the product free.', minimum: 0 })
  @Type(() => Number) @IsInt() @Min(0) amountKobo!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'When the price starts. Leave out for now. Never in the past.' })
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;

  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export const CATEGORY_FLOWS = ['TRANSIT', 'SERVICE'] as const;
type CategoryFlowName = (typeof CATEGORY_FLOWS)[number];

export class AdminCategoryDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() requiresPickup!: boolean;
  @ApiProperty() requiresDestination!: boolean;
  @ApiProperty({ enum: CATEGORY_FLOWS, description: 'TRANSIT moves something between places. SERVICE is work done at one address.' })
  flow!: CategoryFlowName;
  @ApiProperty() isPopular!: boolean;
  @ApiProperty() active!: boolean;
  @ApiProperty() sortOrder!: number;
}

export class CreateCategoryDto extends AdminActionDto {
  @ApiProperty({ description: 'A stable key: lower-case letters, digits and underscores.' })
  @IsString() @MinLength(2) @MaxLength(50) key!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiPropertyOptional({ enum: CATEGORY_FLOWS, default: 'TRANSIT', description: 'SERVICE ignores the two booleans: one address, stored as the destination.' })
  @IsOptional() @IsIn(CATEGORY_FLOWS as unknown as string[]) flow?: CategoryFlowName;
  @ApiPropertyOptional({ description: 'Required for TRANSIT.' }) @IsOptional() @IsBoolean() requiresPickup?: boolean;
  @ApiPropertyOptional({ description: 'Required for TRANSIT.' }) @IsOptional() @IsBoolean() requiresDestination?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPopular?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateCategoryDto extends AdminActionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional({ enum: CATEGORY_FLOWS, description: 'Cannot change once an errand uses the category.' })
  @IsOptional() @IsIn(CATEGORY_FLOWS as unknown as string[]) flow?: CategoryFlowName;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresPickup?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresDestination?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPopular?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class AdminProhibitedItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() category!: string;
  @ApiProperty() keyword!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'INACTIVE'] }) status!: string;
  @ApiProperty() policyVersion!: string;
}

export class CreateProhibitedItemDto extends AdminActionDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(60) category!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) keyword!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiProperty({ description: 'The policy version this rule belongs to.' }) @IsString() @MinLength(1) @MaxLength(20) policyVersion!: string;
}

export class UpdateProhibitedItemDto extends AdminActionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) keyword?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE'] }) @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}

export class PublishPolicyDto extends AdminActionDto {
  @ApiProperty({ enum: ConsentType }) @IsEnum(ConsentType) type!: ConsentType;
  @ApiProperty({ example: '1.1' }) @IsString() @MinLength(1) @MaxLength(20) version!: string;
  @ApiProperty({ description: 'Where the document text lives (a storage path or URL).' }) @IsString() @MinLength(1) @MaxLength(300) documentRef!: string;
  @ApiPropertyOptional({ description: 'Users must accept this version before their next action.' })
  @IsOptional() @IsBoolean() requiresReacceptance?: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) @IsOptional() @Type(() => Date) @IsDate() publishAt?: Date;
}

export class SetTemplateDto extends AdminActionDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @ApiProperty({ maxLength: 500, description: 'May use the placeholders of the built-in copy, and no others.' })
  @IsString() @MinLength(1) @MaxLength(500) body!: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
}

// ---- Service ----

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);

type CategoryRow = { id: string; key: string; name: string; flow: CategoryFlowName; requiresPickup: boolean; requiresDestination: boolean; isPopular: boolean; active: boolean; sortOrder: number };

function toAdminCategory(c: CategoryRow): AdminCategoryDto {
  return {
    id: c.id, key: c.key, name: c.name, flow: c.flow, requiresPickup: c.requiresPickup, requiresDestination: c.requiresDestination,
    isPopular: c.isPopular, active: c.active, sortOrder: c.sortOrder,
  };
}

/** A service is done at one address, stored as the destination. A transit category needs a pickup, a destination, or both. */
function categoryShape(flow: CategoryFlowName, pickup?: boolean, destination?: boolean): { pickup: boolean; destination: boolean } {
  if (flow === 'SERVICE') return { pickup: false, destination: true };
  if (pickup === undefined || destination === undefined) {
    throw DomainException.of(VALIDATION_ERROR, { message: 'A transit category sets requiresPickup and requiresDestination.', details: { field: 'requiresPickup' } });
  }
  if (!pickup && !destination) {
    throw DomainException.of(VALIDATION_ERROR, { message: 'A category needs a pickup, a destination, or both.', details: { field: 'requiresPickup' } });
  }
  return { pickup, destination };
}

@Injectable()
export class AdminConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BusinessConfigService,
    private readonly pricing: PricingService,
    private readonly policies: PolicyService,
  ) {}

  // ---- config ----

  async list(options: { group?: string } = {}) {
    const values = await this.config.getAll();
    const overridden = await this.prisma.$queryRaw<Array<{ key: string; version: number; effective_from: Date }>>`
      SELECT DISTINCT ON (key) key, version, effective_from FROM config_values
      WHERE deleted_at IS NULL AND effective_from <= now() ORDER BY key, effective_from DESC, version DESC
    `;
    const stored = new Map(overridden.map((r) => [r.key, r]));
    const pending = await this.prisma.$queryRaw<Array<{ key: string; effective_from: Date; value_json: unknown }>>`
      SELECT key, effective_from, value_json FROM config_values WHERE deleted_at IS NULL AND effective_from > now()
    `;
    const upcoming = new Map<string, Array<{ effectiveFrom: Date; value: unknown }>>();
    for (const p of pending) {
      upcoming.set(p.key, [...(upcoming.get(p.key) ?? []), { effectiveFrom: p.effective_from, value: p.value_json }]);
    }
    return Object.entries(values as unknown as Record<string, unknown>)
      .map(([key, value]) => ({
        key,
        group: groupOf(key),
        value,
        default: this.config.getDefault(key as never),
        type: typeof value,
        overridden: stored.has(key),
        version: stored.get(key)?.version ?? null,
        needsSecondAdmin: approvalKindFor(key) !== null,
        upcoming: upcoming.get(key) ?? [],
      }))
      .filter((row) => !options.group || row.group === options.group)
      .sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
  }

  async knownKey(key: string): Promise<void> {
    const all = await this.config.getAll();
    if (!(key in (all as unknown as Record<string, unknown>))) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  /** The value must have the key's type: a number key takes a number, a switch takes true or false. */
  async assertType(key: string, value: unknown): Promise<void> {
    const expected = typeof this.config.getDefault(key as never);
    if (typeof value !== expected) {
      throw DomainException.of(VALIDATION_ERROR, { message: `${key} takes a ${expected}.`, details: { field: 'value', expected } });
    }
    if (expected === 'number' && !Number.isFinite(value as number)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The value must be a finite number.', details: { field: 'value' } });
    }
  }

  async history(key: string) {
    await this.knownKey(key);
    const rows = await this.prisma.configValue.findMany({ where: { key, deletedAt: null }, orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }], take: 50 });
    return rows.map((r) => ({ version: r.version, value: r.valueJson, effectiveFrom: r.effectiveFrom, updatedByAdminId: r.updatedByAdminId, createdAt: r.createdAt }));
  }

  async applyConfig(key: string, value: unknown, effectiveFrom: Date | undefined, adminId: string) {
    await this.config.set(key as never, value as never, effectiveFrom, adminId);
    return { key, value, effectiveFrom: effectiveFrom ?? null };
  }

  // ---- pricing ----

  async products() {
    const products = await this.pricing.getActiveProducts();
    const out = [];
    for (const p of products) {
      const history = await this.pricing.getPriceHistory(p.id);
      const now = Date.now();
      out.push({
        id: p.id,
        code: p.code,
        name: p.name,
        type: p.type,
        currentPriceKobo: history.find((v) => v.effectiveFrom.getTime() <= now) ? Number(history.find((v) => v.effectiveFrom.getTime() <= now)!.amountKobo) : null,
        upcoming: history.filter((v) => v.effectiveFrom.getTime() > now).map((v) => ({ id: v.id, amountKobo: Number(v.amountKobo), effectiveFrom: v.effectiveFrom })),
        versions: history.length,
      });
    }
    return out;
  }

  async priceVersions(productId: string) {
    const exists = await this.prisma.commercialProduct.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true } });
    if (!exists) throw DomainException.of(RESOURCE_NOT_FOUND);
    const history = await this.pricing.getPriceHistory(productId);
    return history.map((v) => ({ id: v.id, amountKobo: Number(v.amountKobo), currency: v.currency, effectiveFrom: v.effectiveFrom, notes: v.notes, createdByAdminId: v.createdByAdminId }));
  }

  async productCode(productId: string): Promise<string> {
    const product = await this.prisma.commercialProduct.findFirst({ where: { id: productId, deletedAt: null }, select: { code: true } });
    if (!product) throw DomainException.of(RESOURCE_NOT_FOUND);
    return product.code;
  }

  async applyPrice(productId: string, amountKobo: number, effectiveFrom: Date, notes: string | undefined, adminId: string) {
    const version = await this.pricing.createPriceVersion(productId, amountKobo, effectiveFrom, notes, adminId);
    return { priceVersionId: version.id, productId, amountKobo, effectiveFrom };
  }

  // ---- categories ----

  async categories() {
    const rows = await this.prisma.category.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    return rows.map(toAdminCategory);
  }

  async createCategory(input: CreateCategoryDto): Promise<AdminCategoryDto> {
    if (!/^[a-z][a-z0-9_]*$/.test(input.key)) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The key is lower-case letters, digits and underscores.', details: { field: 'key' } });
    }
    const flow = input.flow ?? 'TRANSIT';
    const shape = categoryShape(flow, input.requiresPickup, input.requiresDestination);
    const dup = await this.prisma.category.findFirst({ where: { key: input.key } });
    if (dup) throw DomainException.of(RESOURCE_CONFLICT, { message: 'A category with this key already exists.' });
    const c = await this.prisma.category.create({
      data: {
        key: input.key, name: input.name.trim(), flow, requiresPickup: shape.pickup, requiresDestination: shape.destination,
        isPopular: input.isPopular ?? false, sortOrder: input.sortOrder ?? 0,
      },
    });
    return toAdminCategory(c);
  }

  async updateCategory(id: string, input: UpdateCategoryDto): Promise<AdminCategoryDto> {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw DomainException.of(RESOURCE_NOT_FOUND);
    const flow = input.flow ?? existing.flow;
    if (flow !== existing.flow && (await this.prisma.errand.count({ where: { categoryId: id } })) > 0) {
      throw DomainException.of(RESOURCE_CONFLICT, { message: 'This category already has errands, so its flow cannot change.', details: { field: 'flow' } });
    }
    const shape = categoryShape(flow, input.requiresPickup ?? existing.requiresPickup, input.requiresDestination ?? existing.requiresDestination);
    const c = await this.prisma.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        flow,
        requiresPickup: shape.pickup,
        requiresDestination: shape.destination,
        ...(input.isPopular !== undefined ? { isPopular: input.isPopular } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    return toAdminCategory(c);
  }

  // ---- prohibited items ----

  async prohibitedItems(): Promise<AdminProhibitedItemDto[]> {
    const rows = await this.prisma.prohibitedItemRule.findMany({ where: { deletedAt: null }, orderBy: [{ category: 'asc' }, { keyword: 'asc' }] });
    return rows.map((r) => ({ id: r.id, category: r.category, keyword: r.keyword, description: r.description, status: r.status, policyVersion: r.policyVersion }));
  }

  async createProhibitedItem(input: CreateProhibitedItemDto): Promise<AdminProhibitedItemDto> {
    const keyword = input.keyword.trim().toLowerCase();
    const dup = await this.prisma.prohibitedItemRule.findFirst({ where: { keyword, deletedAt: null } });
    if (dup) throw DomainException.of(RESOURCE_CONFLICT, { message: 'This keyword is already listed.' });
    // Effective from the database's "now", so it shows in the public list at once whatever the app clock says.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO prohibited_item_rules (category, keyword, description, status, effective_from, policy_version, updated_at)
      VALUES (${input.category.trim()}, ${keyword}, ${input.description?.trim() || null}, 'ACTIVE', clock_timestamp(), ${input.policyVersion}, clock_timestamp())
      RETURNING id::text
    `;
    return { id: rows[0].id, category: input.category.trim(), keyword, description: input.description?.trim() || null, status: 'ACTIVE', policyVersion: input.policyVersion };
  }

  async updateProhibitedItem(id: string, input: UpdateProhibitedItemDto): Promise<AdminProhibitedItemDto> {
    const existing = await this.prisma.prohibitedItemRule.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw DomainException.of(RESOURCE_NOT_FOUND);
    const r = await this.prisma.prohibitedItemRule.update({
      where: { id },
      data: {
        ...(input.keyword !== undefined ? { keyword: input.keyword.trim().toLowerCase() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return { id: r.id, category: r.category, keyword: r.keyword, description: r.description, status: r.status, policyVersion: r.policyVersion };
  }

  // ---- policies ----

  async policyHistory() {
    const out: Record<string, unknown[]> = {};
    for (const type of Object.values(ConsentType)) {
      out[type] = await this.policies.history(type);
    }
    return out;
  }

  async publishPolicy(input: PublishPolicyDto) {
    return this.policies.publish(input.type, input.version, input.documentRef, {
      publishedAt: input.publishAt,
      requiresReacceptance: input.requiresReacceptance,
    });
  }

  // ---- notification templates ----

  async templates() {
    const overrides = await this.prisma.notificationTemplate.findMany({ where: { deletedAt: null } });
    const byKey = new Map(overrides.map((o) => [o.key, o]));
    return Object.entries(TEMPLATE_DEFAULTS)
      .map(([key, d]) => {
        const o = byKey.get(key);
        return {
          key,
          category: d.category,
          emailsToo: d.email === true,
          defaultTitle: d.title,
          defaultBody: d.body,
          overridden: o !== undefined,
          title: o ? o.titleTemplate : d.title,
          body: o ? o.bodyTemplate : d.body,
          active: o ? o.active : true,
          placeholders: placeholdersOf(d.title + ' ' + d.body),
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async setTemplate(key: string, input: SetTemplateDto) {
    const base = TEMPLATE_DEFAULTS[key];
    if (!base) throw DomainException.of(RESOURCE_NOT_FOUND);
    const allowed = new Set(placeholdersOf(base.title + ' ' + base.body));
    const used = placeholdersOf(input.title + ' ' + input.body);
    const unknown = [...new Set(used.filter((p) => !allowed.has(p)))];
    if (unknown.length > 0) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'The copy uses a placeholder this notice does not have.', details: { field: 'body', unknown, allowed: [...allowed] } });
    }
    if (base.category === 'TRANSACTIONAL' || base.category === 'SAFETY') {
      if (input.active === false) {
        throw DomainException.of(VALIDATION_ERROR, { message: 'Account, payment and safety notices cannot be switched off.', details: { field: 'active' } });
      }
    }
    await this.prisma.notificationTemplate.upsert({
      where: { key },
      create: { key, category: base.category, titleTemplate: input.title.trim(), bodyTemplate: input.body.trim(), active: input.active ?? true },
      update: { titleTemplate: input.title.trim(), bodyTemplate: input.body.trim(), active: input.active ?? true, deletedAt: null },
    });
    return (await this.templates()).find((t) => t.key === key);
  }

  async resetTemplate(key: string) {
    if (!TEMPLATE_DEFAULTS[key]) throw DomainException.of(RESOURCE_NOT_FOUND);
    await this.prisma.notificationTemplate.updateMany({ where: { key, deletedAt: null }, data: { deletedAt: new Date() } });
    return (await this.templates()).find((t) => t.key === key);
  }
}

// ---- Controller ----

/** Pricing, configuration, kill switches and reference data (Backend PRD 24.4 areas 14 and 15). */
@ApiTags('Admin configuration')
@Controller('admin')
export class AdminConfigController {
  constructor(
    private readonly service: AdminConfigService,
    private readonly approvals: ApprovalService,
    private readonly actions: AdminActionService,
  ) {}

  // ---- Config ----

  @Get('config')
  @AdminAuth('CONFIG_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  list(@Query('group') group?: string) {
    return this.service.list({ group });
  }

  @Get('config/:key/history')
  @AdminAuth('CONFIG_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(404)
  history(@Param('key') key: string) {
    return this.service.history(key);
  }

  /**
   * Set a value. Kill switches, prices, ladder thresholds and the offer limits are four-eyes:
   * the answer is then the approval request, and the value applies when a second admin approves.
   */
  @Put('config/:key')
  @HttpCode(200)
  @AdminAuth('CONFIG_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async set(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('key') key: string, @Body() dto: SetConfigDto, @ReqCtx() ctx: RequestContext) {
    await this.service.knownKey(key);
    await this.service.assertType(key, dto.value);
    const kind = approvalKindFor(key);
    if (kind) {
      return {
        approvalRequired: true,
        approval: await this.approvals.request(
          admin,
          {
            kind: kind === 'KILL_SWITCH' ? 'KILL_SWITCH' : kind === 'PRICE_CHANGE' ? 'PRICE_CHANGE' : 'CONFIG_CHANGE',
            reason: { code: dto.reasonCode, text: dto.reasonText },
            summary: `Set ${key} to ${String(dto.value)}`,
            targetType: 'config_value',
            targetId: key,
            payload: { type: 'CONFIG', key, value: dto.value, effectiveFrom: dto.effectiveFrom?.toISOString() ?? null },
          },
          ctx,
        ),
      };
    }
    await this.actions.run({
      admin,
      action: 'config.set',
      entityType: 'config_value',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { key },
      before: async () => ({ value: (await this.service.history(key))[0]?.value ?? null }),
      after: async () => ({ value: dto.value }),
      execute: () => this.service.applyConfig(key, dto.value, dto.effectiveFrom, admin.adminId),
    });
    return { approvalRequired: false, key, value: dto.value };
  }

  // ---- Kill switches ----

  @Get('flags')
  @AdminAuth('CONFIG_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  async flags() {
    return (await this.service.list({ group: 'Kill switches' })).map((f) => ({ key: f.key, enabled: f.value, default: f.default, upcoming: f.upcoming }));
  }

  /** Turn a feature on or off. Four-eyes: a second admin approves, then it takes effect. */
  @Put('flags/:key')
  @HttpCode(200)
  @AdminAuth('FEATURE_FLAGS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async setFlag(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('key') key: string, @Body() dto: SetFlagDto, @ReqCtx() ctx: RequestContext) {
    if (!key.startsWith('FEATURE_')) throw DomainException.of(RESOURCE_NOT_FOUND);
    await this.service.knownKey(key);
    return {
      approvalRequired: true,
      approval: await this.approvals.request(
        admin,
        {
          kind: 'KILL_SWITCH',
          reason: { code: dto.reasonCode, text: dto.reasonText },
          summary: `${dto.enabled ? 'Turn on' : 'Turn off'} ${key}`,
          targetType: 'config_value',
          targetId: key,
          payload: { type: 'CONFIG', key, value: dto.enabled, effectiveFrom: null },
        },
        ctx,
      ),
    };
  }

  // ---- Pricing ----

  @Get('pricing/products')
  @AdminAuth('PRICING_MANAGE')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  products() {
    return this.service.products();
  }

  @Get('pricing/products/:id/versions')
  @AdminAuth('PRICING_MANAGE')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(404)
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.priceVersions(id);
  }

  /** Schedule a new price. Four-eyes: it becomes a price version, with its start time, when a second admin approves. */
  @Post('pricing/products/:id/prices')
  @HttpCode(200)
  @AdminAuth('PRICING_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async setPrice(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPriceDto, @ReqCtx() ctx: RequestContext) {
    const code = await this.service.productCode(id);
    const effectiveFrom = dto.effectiveFrom ?? new Date(Date.now() + 60_000);
    if (effectiveFrom.getTime() < Date.now() - 1000) {
      throw DomainException.of(VALIDATION_ERROR, { message: 'A price cannot start in the past.', details: { field: 'effectiveFrom' } });
    }
    return {
      approvalRequired: true,
      approval: await this.approvals.request(
        admin,
        {
          kind: 'PRICE_CHANGE',
          reason: { code: dto.reasonCode, text: dto.reasonText },
          summary: `Set the price of ${code} to ${dto.amountKobo} kobo from ${effectiveFrom.toISOString()}`,
          targetType: 'commercial_product',
          targetId: id,
          payload: { type: 'PRICE', productId: id, amountKobo: dto.amountKobo, effectiveFrom: effectiveFrom.toISOString(), notes: dto.notes ?? null },
        },
        ctx,
      ),
    };
  }

  // ---- Categories ----

  @Get('categories')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminCategoryDto, { isArray: true })
  categories() {
    return this.service.categories();
  }

  @Post('categories')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminCategoryDto, { status: 201 })
  @ApiErrors(400, 403, 409)
  createCategory(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateCategoryDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'category.create',
      entityType: 'category',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { key: dto.key },
      execute: () => this.service.createCategory(dto),
    });
  }

  @Patch('categories/:id')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminCategoryDto)
  @ApiErrors(400, 403, 404)
  updateCategory(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'category.update',
      entityType: 'category',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.updateCategory(id, dto),
    });
  }

  // ---- Prohibited items ----

  @Get('prohibited-items')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminProhibitedItemDto, { isArray: true })
  prohibited() {
    return this.service.prohibitedItems();
  }

  @Post('prohibited-items')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminProhibitedItemDto, { status: 201 })
  @ApiErrors(400, 403, 409)
  createProhibited(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateProhibitedItemDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'prohibited_item.create',
      entityType: 'prohibited_item_rule',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.createProhibitedItem(dto),
    });
  }

  @Patch('prohibited-items/:id')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AdminProhibitedItemDto)
  @ApiErrors(400, 403, 404)
  updateProhibited(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProhibitedItemDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'prohibited_item.update',
      entityType: 'prohibited_item_rule',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.service.updateProhibitedItem(id, dto),
    });
  }

  // ---- Policies ----

  @Get('policies')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  policies() {
    return this.service.policyHistory();
  }

  /** Publish a policy version. With `requiresReacceptance`, users must accept it before their next action. */
  @Post('policies')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 409)
  publishPolicy(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: PublishPolicyDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'policy.publish',
      entityType: 'policy_version',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { type: dto.type, version: dto.version, requiresReacceptance: dto.requiresReacceptance ?? false },
      execute: () => this.service.publishPolicy(dto),
    });
  }

  // ---- Notification templates ----

  @Get('notification-templates')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  templates() {
    return this.service.templates();
  }

  @Put('notification-templates/:key')
  @HttpCode(200)
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  setTemplate(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('key') key: string, @Body() dto: SetTemplateDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'notification_template.set',
      entityType: 'notification_template',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { key },
      execute: () => this.service.setTemplate(key, dto),
    });
  }

  /** Back to the built-in copy. */
  @Delete('notification-templates/:key')
  @HttpCode(200)
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  resetTemplate(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('key') key: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'notification_template.reset',
      entityType: 'notification_template',
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { key },
      execute: () => this.service.resetTemplate(key),
    });
  }

  // ---- Reasons (read only: they are the platform's own codes) ----

  @Get('reference/reasons')
  @AdminAuth('REFERENCE_DATA_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  reasons() {
    return {
      cancellationReasons: [
        'REQUESTER_CANCELLED', 'RUNNER_CANCELLED', 'RUNNER_REJECTED_ASSIGNMENT', 'NO_RUNNER_AVAILABLE', 'SAFETY_CONCERN',
        'DUPLICATE_ERRAND', 'USER_ACCOUNT_RESTRICTED', 'ADMIN_CANCELLED', 'OTHER',
      ],
      reportTypes: [
        'USER_BEHAVIOR', 'ERRAND', 'NON_PAYMENT', 'OVERCHARGING', 'LOST_ITEM', 'DAMAGED_ITEM', 'ABUSE', 'HARASSMENT', 'FRAUD',
        'UNSAFE_BEHAVIOR', 'PROHIBITED_ITEM', 'SPAM', 'FAKE_ACCOUNT', 'OTHER',
      ],
      disputeTypes: ['ITEM_NOT_DELIVERED', 'ITEM_DAMAGED', 'ITEM_MISSING', 'WRONG_ITEM', 'UNAUTHORIZED_CHANGE', 'SAFETY_INCIDENT', 'SERVICE_NOT_DONE', 'POOR_QUALITY', 'PROPERTY_DAMAGE', 'OTHER'],
    };
  }
}
