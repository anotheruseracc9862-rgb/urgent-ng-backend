import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CategoryFlow, DisputeStatus, Prisma, RatingStatus, ReportStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '../../database/prisma.service.js';
import { Paginated } from '../../common/pagination/paginated.js';
import { PaginationQueryDto } from '../../common/pagination/pagination.dto.js';
import { DomainException } from '../../common/exceptions/domain.exception.js';
import { RESOURCE_NOT_FOUND } from '../../common/constants/error-codes.js';
import { ApiEnveloped, ApiErrors } from '../../common/api/api-docs.js';
import { ReqCtx } from '../../auth/decorators/request-context.decorator.js';
import type { RequestContext } from '../../auth/auth-audit.service.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../../admin/decorators/admin-auth.decorator.js';
import { AdminActionService } from '../../admin/framework/admin-action.service.js';
import { ADMIN_REASON_CODES, AdminActionDto, type AdminReasonCode } from '../../admin/framework/admin-reasons.js';
import { SensitiveAccessService } from '../../admin/framework/sensitive-access.service.js';
import { DisputeService } from '../../disputes/dispute.service.js';
import { ReportService } from '../../reports/report.service.js';
import { NoShowService } from '../../reliability/no-show.service.js';
import { RatingService } from '../../ratings/rating.service.js';
import { EnforcementService } from '../../enforcement/enforcement.service.js';
import { AdminPager } from '../common/admin-page.js';
import { AnyObjectDto } from '../common/any-object.dto.js';

// ---- DTOs ----

export class CaseListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() errandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignmentId?: string;
  @ApiPropertyOptional({ description: 'Only cases assigned to you.' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() mine?: boolean;
  @ApiPropertyOptional({ description: 'Only cases past their response or resolution deadline.' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() overdue?: boolean;
  @ApiPropertyOptional({ description: 'Only cases nobody owns yet.' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() unassigned?: boolean;
}

export class DisputeListQueryDto extends CaseListQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus }) @IsOptional() @IsEnum(DisputeStatus) status?: DisputeStatus;
}

export class ReportListQueryDto extends CaseListQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus }) @IsOptional() @IsEnum(ReportStatus) status?: ReportStatus;
  @ApiPropertyOptional({ enum: ['USER', 'ERRAND', 'MESSAGE', 'RATING'] })
  @IsOptional() @IsIn(['USER', 'ERRAND', 'MESSAGE', 'RATING']) targetType?: string;
}

export class AssignCaseDto extends AdminActionDto {
  @ApiPropertyOptional({ description: 'The admin who takes the case. Leave out to take it yourself.' })
  @IsOptional() @IsUUID() adminId?: string;
}

export class CaseNoteDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}

export class ResolveFactDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty({ description: 'A reliability fact an admin may record, for example NO_SHOW or FALSE_CLAIM.' })
  @IsString() @MaxLength(60) type!: string;
}

export class EscalateUserDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(300) reason!: string;
}

export class ResolveDisputeDto extends AdminActionDto {
  @ApiProperty({ enum: ['COMPLETE', 'CANCEL', 'DISMISS'], description: 'COMPLETE marks the errand done, CANCEL cancels it, DISMISS returns it to where it was.' })
  @IsIn(['COMPLETE', 'CANCEL', 'DISMISS']) outcome!: 'COMPLETE' | 'CANCEL' | 'DISMISS';
  @ApiProperty({ description: 'The decision, in words both parties are shown.', maxLength: 2000 })
  @IsString() @MinLength(1) @MaxLength(2000) notes!: string;
  @ApiPropertyOptional({ type: ResolveFactDto, isArray: true })
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => ResolveFactDto) facts?: ResolveFactDto[];
  @ApiPropertyOptional({ type: EscalateUserDto, isArray: true, description: 'Parties to put in front of an admin as a severe event.' })
  @IsOptional() @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => EscalateUserDto) escalate?: EscalateUserDto[];
}

export class ReportStatusDto extends AdminActionDto {
  @ApiProperty({ enum: ['UNDER_REVIEW', 'ACTION_REQUIRED'] }) @IsIn(['UNDER_REVIEW', 'ACTION_REQUIRED']) status!: 'UNDER_REVIEW' | 'ACTION_REQUIRED';
}

export class LinkDisputeDto extends AdminActionDto {
  @ApiProperty() @IsUUID() disputeId!: string;
}

export class ResolveReportDto extends AdminActionDto {
  @ApiProperty({ enum: ['UPHELD', 'DISMISSED'] }) @IsIn(['UPHELD', 'DISMISSED']) outcome!: 'UPHELD' | 'DISMISSED';
  @ApiProperty({ description: 'The decision note.', maxLength: 2000 }) @IsString() @MinLength(1) @MaxLength(2000) resolution!: string;
}

export class ResolveNoShowDto extends AdminActionDto {
  @ApiProperty({ enum: ['CONFIRM', 'DISMISS'] }) @IsIn(['CONFIRM', 'DISMISS']) outcome!: 'CONFIRM' | 'DISMISS';
}

export class NoShowListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'CONTESTED', 'CONFIRMED', 'DISMISSED'], default: 'CONTESTED' })
  @IsOptional() @IsIn(['PENDING', 'CONTESTED', 'CONFIRMED', 'DISMISSED']) status?: string;
}

export class RatingListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RatingStatus }) @IsOptional() @IsEnum(RatingStatus) status?: RatingStatus;
  @ApiPropertyOptional({ description: 'Review text, rater or ratee name.', maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class ModerateRatingDto extends AdminActionDto {
  @ApiProperty({ enum: RatingStatus, description: 'HIDDEN and REMOVED stop the rating counting. PUBLISHED restores it.' })
  @IsEnum(RatingStatus) status!: RatingStatus;
}

export class ChatViewQueryDto extends PaginationQueryDto {
  @ApiProperty({ enum: ADMIN_REASON_CODES, description: 'Why the conversation is being read. Recorded with the view.' })
  @IsIn(ADMIN_REASON_CODES as unknown as string[]) reasonCode!: AdminReasonCode;
}

export class AdminChatPageMetaDto {
  @ApiProperty() hasNextPage!: boolean;
  @ApiPropertyOptional() nextCursor?: string;
}

export class AdminDisputeChatDto {
  @ApiProperty({ type: String, nullable: true }) conversationId!: string | null;
  @ApiProperty({ type: AnyObjectDto, isArray: true }) messages!: Array<Record<string, unknown>>;
  @ApiProperty({ type: AdminChatPageMetaDto }) meta!: AdminChatPageMetaDto;
}

export class CaseRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ nullable: true, type: String }) type!: string | null;
  @ApiProperty({ nullable: true, type: String }) errandId!: string | null;
  @ApiProperty({ nullable: true, type: String }) assignmentId!: string | null;
  @ApiProperty({ nullable: true, enum: CategoryFlow }) categoryFlow!: CategoryFlow | null;
  @ApiProperty({ nullable: true, type: String }) errandTitle!: string | null;
  @ApiProperty({ nullable: true, type: String }) assignedTo!: string | null;
  @ApiProperty({ nullable: true, type: Date }) slaDueAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) resolutionDueAt!: Date | null;
  @ApiProperty({ description: 'A deadline has passed and the case is still open.' }) overdue!: boolean;
  @ApiProperty({ nullable: true, type: Date }) escalatedAt!: Date | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

// ---- Service ----

@Injectable()
export class AdminCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pager: AdminPager,
  ) {}

  async disputes(adminId: string, q: DisputeListQueryDto): Promise<Paginated<CaseRowDto>> {
    const limit = q.limit ?? 20;
    const priority = q.overdue || q.unassigned;
    const after = priority ? undefined : this.pager.after(q.cursor);
    const deadline = priority ? this.pager.deadline(q.cursor) : undefined;
    const c: Prisma.Sql[] = [Prisma.sql`d.deleted_at IS NULL`];
    if (q.errandId) c.push(Prisma.sql`d.errand_id = ${q.errandId}::uuid`);
    if (q.assignmentId) c.push(Prisma.sql`d.assignment_id = ${q.assignmentId}::uuid`);
    if (deadline) c.push(deadline.dueAt === null
      ? Prisma.sql`(d.sla_due_at IS NULL AND d.id > ${deadline.id}::uuid)`
      : Prisma.sql`(d.sla_due_at IS NULL OR (d.sla_due_at, d.id) > (${deadline.dueAt}::timestamptz, ${deadline.id}::uuid))`);
    if (q.status) c.push(Prisma.sql`d.status = ${q.status}::"DisputeStatus"`);
    if (q.mine) c.push(Prisma.sql`d.assigned_to = ${adminId}::uuid`);
    if (q.unassigned) c.push(Prisma.sql`d.assigned_to IS NULL`);
    if (q.overdue) {
      c.push(Prisma.sql`d.status IN ('OPEN'::"DisputeStatus", 'UNDER_REVIEW'::"DisputeStatus")
        AND ((d.first_response_at IS NULL AND d.sla_due_at < clock_timestamp()) OR d.resolution_due_at < clock_timestamp())`);
    }
    if (after) c.push(Prisma.sql`(d.created_at, d.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; status: string; type: string; errand_id: string; assignment_id: string; category_flow: CategoryFlow; title: string; assigned_to: string | null;
        sla_due_at: Date | null; resolution_due_at: Date | null; overdue: boolean; escalated_at: Date | null; created_at: Date;
      }>
    >`
      SELECT d.id::text AS id, d.status::text AS status, d.type::text AS type, d.errand_id::text AS errand_id, d.assignment_id::text AS assignment_id, cat.flow AS category_flow, e.title,
             d.assigned_to::text AS assigned_to, d.sla_due_at, d.resolution_due_at, d.escalated_at, d.created_at,
             (d.status IN ('OPEN'::"DisputeStatus", 'UNDER_REVIEW'::"DisputeStatus")
               AND ((d.first_response_at IS NULL AND d.sla_due_at < clock_timestamp()) OR d.resolution_due_at < clock_timestamp())) AS overdue
      FROM disputes d JOIN errands e ON e.id = d.errand_id JOIN categories cat ON cat.id = e.category_id
      WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY ${q.overdue || q.unassigned ? Prisma.sql`d.sla_due_at ASC NULLS LAST, d.id ASC` : Prisma.sql`d.created_at DESC, d.id DESC`}
      LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): CaseRowDto => ({
      id: r.id, status: r.status, kind: 'DISPUTE', type: r.type, errandId: r.errand_id, errandTitle: r.title, assignedTo: r.assigned_to,
      assignmentId: r.assignment_id, categoryFlow: r.category_flow,
      slaDueAt: r.sla_due_at, resolutionDueAt: r.resolution_due_at, overdue: r.overdue, escalatedAt: r.escalated_at, createdAt: r.created_at,
    }), priority ? (r) => `sla:${r.sla_due_at?.toISOString() ?? 'null'}` : undefined);
  }

  async disputeWorkspace(disputeId: string): Promise<Record<string, unknown>> {
    const d = await this.prisma.dispute.findFirst({ where: { id: disputeId, deletedAt: null }, include: { evidence: true } });
    if (!d) throw DomainException.of(RESOURCE_NOT_FOUND);
    const [assignment, errand, events, checkpoints, problems, reports, notes] = await Promise.all([
      this.prisma.assignment.findUnique({
        where: { id: d.assignmentId },
        include: { requester: { select: { id: true, name: true } }, runner: { select: { id: true, name: true } }, paymentAgreement: true },
      }),
      this.prisma.errand.findUnique({ where: { id: d.errandId }, select: { id: true, title: true, status: true, statusBeforeDispute: true, category: { select: { flow: true } } } }),
      this.prisma.executionEvent.findMany({ where: { assignmentId: d.assignmentId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.checkpoint.findMany({ where: { assignmentId: d.assignmentId }, select: { type: true, capturedAt: true, note: true, mediaId: true } }),
      this.prisma.executionProblem.findMany({ where: { assignmentId: d.assignmentId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.report.findMany({ where: { OR: [{ disputeId }, { assignmentId: d.assignmentId }], deletedAt: null }, select: { id: true, type: true, status: true, createdAt: true } }),
      this.notes('dispute', disputeId),
    ]);
    return {
      id: d.id,
      assignmentId: d.assignmentId,
      type: d.type,
      status: d.status,
      claim: d.claim,
      openedBy: d.openedBy,
      resolution: d.resolution,
      resolutionNotes: d.resolutionNotes,
      resolvedAt: d.resolvedAt,
      slaDueAt: d.slaDueAt,
      resolutionDueAt: d.resolutionDueAt,
      firstResponseAt: d.firstResponseAt,
      assignedTo: d.assignedTo,
      escalatedAt: d.escalatedAt,
      createdAt: d.createdAt,
      errand,
      requester: assignment?.requester ?? null,
      runner: assignment?.runner ?? null,
      agreedAmountMinor: assignment ? Number(assignment.agreedAmountMinor) : null,
      paymentAgreement: assignment?.paymentAgreement
        ? { method: assignment.paymentAgreement.paymentMethod, timing: assignment.paymentAgreement.paymentTiming }
        : null,
      evidence: d.evidence.map((e) => ({ id: e.id, sourceType: e.sourceType, sourceId: e.sourceId, statement: e.statement, addedBy: e.addedBy, createdAt: e.createdAt })),
      timeline: events.map((e) => ({ at: e.createdAt, type: e.type, actorType: e.actorType, note: e.note })),
      checkpoints,
      problems: problems.map((p) => ({ id: p.id, type: p.type, status: p.status, note: p.note, mediaId: p.mediaId })),
      reports,
      notes,
    };
  }

  /** Chat extracts for a dispute: the messages of the conversation between its two parties. */
  async disputeChat(disputeId: string, limit: number, cursor?: string): Promise<AdminDisputeChatDto> {
    this.pager.after(cursor);
    const d = await this.prisma.dispute.findFirst({ where: { id: disputeId, deletedAt: null }, select: { assignmentId: true } });
    if (!d) throw DomainException.of(RESOURCE_NOT_FOUND);
    const a = await this.prisma.assignment.findUniqueOrThrow({ where: { id: d.assignmentId }, select: { errandId: true, runnerId: true } });
    const conversation = await this.prisma.conversation.findFirst({ where: { errandId: a.errandId, runnerId: a.runnerId, deletedAt: null }, select: { id: true } });
    if (!conversation) return { conversationId: null, messages: [], meta: { hasNextPage: false } };
    const page = await this.messages(conversation.id, limit, cursor);
    return { conversationId: conversation.id, messages: page.items, meta: page.meta };
  }

  async messages(conversationId: string, limit: number, cursor?: string): Promise<Paginated<Record<string, unknown>>> {
    const after = this.pager.after(cursor);
    const rows = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null,
        ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { sender: { select: { id: true, name: true } } },
    });
    return this.pager.page(rows, limit, (m) => ({
      id: m.id,
      sender: m.sender,
      type: m.type,
      body: m.body,
      mediaId: m.mediaId,
      status: m.status,
      removalReason: m.removalReason,
      createdAt: m.createdAt,
    }));
  }

  async conversationExists(conversationId: string): Promise<void> {
    const c = await this.prisma.conversation.findFirst({ where: { id: conversationId, deletedAt: null }, select: { id: true } });
    if (!c) throw DomainException.of(RESOURCE_NOT_FOUND);
  }

  async messageSender(messageId: string): Promise<string> {
    const m = await this.prisma.message.findFirst({ where: { id: messageId, deletedAt: null }, select: { senderId: true } });
    if (!m) throw DomainException.of(RESOURCE_NOT_FOUND);
    return m.senderId;
  }

  async reports(adminId: string, q: ReportListQueryDto): Promise<Paginated<CaseRowDto>> {
    const limit = q.limit ?? 20;
    const priority = q.overdue || q.unassigned;
    const after = priority ? undefined : this.pager.after(q.cursor);
    const deadline = priority ? this.pager.deadline(q.cursor) : undefined;
    const c: Prisma.Sql[] = [Prisma.sql`r.deleted_at IS NULL`];
    if (q.errandId) c.push(Prisma.sql`r.errand_id = ${q.errandId}::uuid`);
    if (q.assignmentId) c.push(Prisma.sql`r.assignment_id = ${q.assignmentId}::uuid`);
    if (deadline) c.push(deadline.dueAt === null
      ? Prisma.sql`(r.sla_due_at IS NULL AND r.id > ${deadline.id}::uuid)`
      : Prisma.sql`(r.sla_due_at IS NULL OR (r.sla_due_at, r.id) > (${deadline.dueAt}::timestamptz, ${deadline.id}::uuid))`);
    if (q.status) c.push(Prisma.sql`r.status = ${q.status}::"ReportStatus"`);
    if (q.targetType) c.push(Prisma.sql`r.target_type::text = ${q.targetType}`);
    if (q.mine) c.push(Prisma.sql`r.assigned_to = ${adminId}::uuid`);
    if (q.unassigned) c.push(Prisma.sql`r.assigned_to IS NULL`);
    if (q.overdue) c.push(Prisma.sql`r.status IN ('OPEN'::"ReportStatus", 'UNDER_REVIEW'::"ReportStatus", 'ACTION_REQUIRED'::"ReportStatus") AND r.first_response_at IS NULL AND r.sla_due_at < clock_timestamp()`);
    if (after) c.push(Prisma.sql`(r.created_at, r.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; status: string; type: string; errand_id: string | null; assignment_id: string | null; category_flow: CategoryFlow | null; title: string | null; assigned_to: string | null;
        sla_due_at: Date | null; overdue: boolean; escalated_at: Date | null; created_at: Date;
      }>
    >`
      SELECT r.id::text AS id, r.status::text AS status, r.type::text AS type, r.errand_id::text AS errand_id, r.assignment_id::text AS assignment_id, cat.flow AS category_flow, e.title,
             r.assigned_to::text AS assigned_to, r.sla_due_at, r.escalated_at, r.created_at,
             (r.status IN ('OPEN'::"ReportStatus", 'UNDER_REVIEW'::"ReportStatus", 'ACTION_REQUIRED'::"ReportStatus")
               AND r.first_response_at IS NULL AND r.sla_due_at < clock_timestamp()) AS overdue
      FROM reports r LEFT JOIN errands e ON e.id = r.errand_id LEFT JOIN categories cat ON cat.id = e.category_id
      WHERE ${Prisma.join(c, ' AND ')}
      ORDER BY ${q.overdue || q.unassigned ? Prisma.sql`r.sla_due_at ASC NULLS LAST, r.id ASC` : Prisma.sql`r.created_at DESC, r.id DESC`}
      LIMIT ${limit + 1}
    `;
    return this.pager.page(rows.map((r) => ({ ...r, createdAt: r.created_at })), limit, (r): CaseRowDto => ({
      id: r.id, status: r.status, kind: 'REPORT', type: r.type, errandId: r.errand_id, errandTitle: r.title, assignedTo: r.assigned_to,
      assignmentId: r.assignment_id, categoryFlow: r.category_flow,
      slaDueAt: r.sla_due_at, resolutionDueAt: null, overdue: r.overdue, escalatedAt: r.escalated_at, createdAt: r.created_at,
    }), priority ? (r) => `sla:${r.sla_due_at?.toISOString() ?? 'null'}` : undefined);
  }

  async reportDetail(reportId: string): Promise<Record<string, unknown>> {
    const r = await this.prisma.report.findFirst({ where: { id: reportId, deletedAt: null }, include: { evidence: true } });
    if (!r) throw DomainException.of(RESOURCE_NOT_FOUND);
    const [reporter, target, notes, errand] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: r.reporterId }, select: { id: true, name: true } }),
      r.targetUserId ? this.prisma.user.findFirst({ where: { id: r.targetUserId }, select: { id: true, name: true } }) : Promise.resolve(null),
      this.notes('report', reportId),
      r.errandId ? this.prisma.errand.findUnique({ where: { id: r.errandId }, select: { category: { select: { flow: true } } } }) : Promise.resolve(null),
    ]);
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      targetType: r.targetType,
      description: (r as unknown as { description?: string }).description ?? null,
      reporter,
      target,
      errandId: r.errandId,
      categoryFlow: errand?.category.flow ?? null,
      assignmentId: r.assignmentId,
      messageId: r.messageId,
      ratingId: r.ratingId,
      disputeId: r.disputeId,
      outcome: (r as unknown as { outcome?: string }).outcome ?? null,
      resolution: (r as unknown as { resolution?: string }).resolution ?? null,
      slaDueAt: r.slaDueAt,
      firstResponseAt: r.firstResponseAt,
      assignedTo: r.assignedTo,
      escalatedAt: r.escalatedAt,
      pausesAutoCompletion: r.pausesAutoCompletion,
      createdAt: r.createdAt,
      evidence: r.evidence.map((e) => ({ id: e.id, sourceType: e.sourceType, sourceId: e.sourceId, statement: e.statement })),
      notes,
    };
  }

  async noShows(q: { status?: string; cursor?: string; limit?: number }): Promise<Paginated<Record<string, unknown> & { id: string; createdAt: Date }>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const rows = await this.prisma.noShowReport.findMany({
      where: {
        deletedAt: null,
        status: q.status ?? 'CONTESTED',
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows, limit, (r) => ({
      id: r.id,
      createdAt: r.createdAt,
      assignmentId: r.assignmentId,
      errandId: r.errandId,
      reporterId: r.reporterId,
      accusedId: r.accusedId,
      status: r.status,
      note: r.note,
      responseDueAt: r.responseDueAt,
      respondedAt: r.respondedAt,
    }));
  }

  async ratings(q: { status?: RatingStatus; q?: string; cursor?: string; limit?: number }): Promise<Paginated<Record<string, unknown> & { id: string; createdAt: Date }>> {
    const limit = q.limit ?? 20;
    const after = this.pager.after(q.cursor);
    const term = q.q?.trim();
    const rows = await this.prisma.rating.findMany({
      where: {
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(term
          ? {
              OR: [
                { review: { contains: term, mode: 'insensitive' as const } },
                { rater: { name: { contains: term, mode: 'insensitive' as const } } },
                { ratee: { name: { contains: term, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
        ...(after ? { AND: [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] } : {}),
      },
      include: { scores: true, rater: { select: { id: true, name: true } }, ratee: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.pager.page(rows, limit, (r) => ({
      id: r.id,
      createdAt: r.createdAt,
      assignmentId: r.assignmentId,
      direction: r.direction,
      status: r.status,
      revealed: r.revealedAt !== null,
      review: r.review,
      overall: r.scores.find((s) => s.dimension === 'OVERALL')?.score ?? null,
      rater: r.rater,
      ratee: r.ratee,
    }));
  }

  // ---- case ownership and notes ----

  async assign(entity: 'disputes' | 'reports', id: string, adminId: string): Promise<{ id: string; assignedTo: string }> {
    const table = Prisma.raw(entity);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE ${table} SET assigned_to = ${adminId}::uuid, assigned_at = clock_timestamp()
      WHERE id = ${id}::uuid AND deleted_at IS NULL RETURNING id::text
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return { id, assignedTo: adminId };
  }

  async escalate(entity: 'disputes' | 'reports', id: string, adminId: string): Promise<{ id: string; escalatedAt: Date }> {
    const table = Prisma.raw(entity);
    const rows = await this.prisma.$queryRaw<Array<{ at: Date }>>`
      UPDATE ${table} SET escalated_at = clock_timestamp(), escalated_by = ${adminId}::uuid
      WHERE id = ${id}::uuid AND deleted_at IS NULL RETURNING escalated_at AS at
    `;
    if (!rows[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    return { id, escalatedAt: rows[0].at };
  }

  async addNote(entityType: 'dispute' | 'report', entityId: string, adminId: string, body: string) {
    const table = entityType === 'dispute' ? 'disputes' : 'reports';
    const exists = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM ${Prisma.raw(table)} WHERE id = ${entityId}::uuid AND deleted_at IS NULL
    `;
    if (!exists[0]) throw DomainException.of(RESOURCE_NOT_FOUND);
    const note = await this.prisma.adminCaseNote.create({ data: { entityType, entityId, adminId, body: body.trim() } });
    return { id: note.id, body: note.body, adminId, createdAt: note.createdAt };
  }

  private async notes(entityType: string, entityId: string) {
    const rows = await this.prisma.adminCaseNote.findMany({ where: { entityType, entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((n) => ({ id: n.id, adminId: n.adminId, body: n.body, createdAt: n.createdAt }));
  }
}

// ---- Controller ----

/** Disputes, reports, no-shows, ratings and messages (Backend PRD 24.4 areas 6, 7, 9 and 10). */
@ApiTags('Admin cases')
@Controller('admin')
export class AdminCasesController {
  constructor(
    private readonly cases: AdminCasesService,
    private readonly disputes: DisputeService,
    private readonly reports: ReportService,
    private readonly noShows: NoShowService,
    private readonly ratingService: RatingService,
    private readonly enforcement: EnforcementService,
    private readonly actions: AdminActionService,
    private readonly sensitive: SensitiveAccessService,
  ) {}

  // ---- Disputes ----

  @Get('disputes')
  @AdminAuth('DISPUTES_VIEW')
  @ApiEnveloped(CaseRowDto, { isArray: true })
  @ApiErrors(400)
  disputeQueue(@CurrentAdmin() admin: AuthenticatedAdmin, @Query() query: DisputeListQueryDto) {
    return this.cases.disputes(admin.adminId, query);
  }

  /** The case workspace: the claim, evidence, execution record, checkpoints, problems, linked reports and notes. */
  @Get('disputes/:id')
  @AdminAuth('DISPUTES_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  disputeCase(@Param('id', ParseUUIDPipe) id: string) {
    return this.cases.disputeWorkspace(id);
  }

  /** Chat extracts for the case. Needs CHAT_SENSITIVE_VIEW and a reason; audited. */
  @Get('disputes/:id/chat')
  @AdminAuth('DISPUTES_VIEW', 'CHAT_SENSITIVE_VIEW')
  @ApiEnveloped(AdminDisputeChatDto, { description: 'Oldest-first messages. Continue with data.meta.nextCursor; each page requires a reason and is audited.' })
  @ApiErrors(400, 403, 404)
  async disputeChat(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Query() query: ChatViewQueryDto, @ReqCtx() ctx: RequestContext) {
    const chat = await this.cases.disputeChat(id, query.limit ?? 50, query.cursor);
    await this.sensitive.record({
      admin,
      permission: 'CHAT_SENSITIVE_VIEW',
      resource: 'dispute.chat',
      entityType: 'dispute',
      entityId: id,
      reasonText: query.reasonCode,
      ctx,
    });
    return chat;
  }

  @Post('disputes/:id/start-review')
  @HttpCode(200)
  @AdminAuth('DISPUTES_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async startReview(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const d = await this.actions.run({
      admin,
      action: 'dispute.start_review',
      entityType: 'dispute',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.disputes.adminStartReview(id, { adminId: admin.adminId }),
    });
    return { id: d.id, status: d.status, firstResponseAt: d.firstResponseAt };
  }

  @Post('disputes/:id/assign')
  @HttpCode(200)
  @AdminAuth('DISPUTES_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  assignDispute(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignCaseDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'dispute.assign',
      entityType: 'dispute',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.cases.assign('disputes', id, dto.adminId ?? admin.adminId),
    });
  }

  @Post('disputes/:id/escalate')
  @HttpCode(200)
  @AdminAuth('DISPUTES_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  escalateDispute(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'dispute.escalate',
      entityType: 'dispute',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.cases.escalate('disputes', id, admin.adminId),
    });
  }

  @Post('disputes/:id/notes')
  @AdminAuth('DISPUTES_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 404)
  disputeNote(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CaseNoteDto) {
    return this.cases.addNote('dispute', id, admin.adminId, dto.body);
  }

  @Post('disputes/:id/resolve')
  @HttpCode(200)
  @AdminAuth('DISPUTES_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async resolveDispute(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDisputeDto, @ReqCtx() ctx: RequestContext) {
    const d = await this.actions.run({
      admin,
      action: 'dispute.resolve',
      entityType: 'dispute',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { outcome: dto.outcome },
      execute: () =>
        this.disputes.adminResolve(
          id,
          {
            outcome: dto.outcome,
            notes: dto.notes,
            facts: dto.facts as Parameters<DisputeService['adminResolve']>[1]['facts'],
            escalate: dto.escalate,
          },
          { adminId: admin.adminId },
        ),
    });
    return { id: d.id, status: d.status, resolution: d.resolution, resolvedAt: d.resolvedAt };
  }

  // ---- Reports ----

  @Get('reports')
  @AdminAuth('REPORTS_VIEW')
  @ApiEnveloped(CaseRowDto, { isArray: true })
  @ApiErrors(400)
  reportQueue(@CurrentAdmin() admin: AuthenticatedAdmin, @Query() query: ReportListQueryDto) {
    return this.cases.reports(admin.adminId, query);
  }

  @Get('reports/:id')
  @AdminAuth('REPORTS_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(404)
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.cases.reportDetail(id);
  }

  @Post('reports/:id/status')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async reportStatus(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportStatusDto, @ReqCtx() ctx: RequestContext) {
    const r = await this.actions.run({
      admin,
      action: 'report.set_status',
      entityType: 'report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { status: dto.status },
      execute: () => this.reports.adminSetStatus(id, dto.status, { adminId: admin.adminId }),
    });
    return { id: r.id, status: r.status };
  }

  /** Link a report to a dispute so one case is decided once. */
  @Post('reports/:id/link-dispute')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE', 'DISPUTES_VIEW')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async linkDispute(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkDisputeDto, @ReqCtx() ctx: RequestContext) {
    const r = await this.actions.run({
      admin,
      action: 'report.link_dispute',
      entityType: 'report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { disputeId: dto.disputeId },
      execute: () => this.reports.adminLinkToDispute(id, dto.disputeId, { adminId: admin.adminId }),
    });
    return { id: r.id, disputeId: r.disputeId };
  }

  @Post('reports/:id/assign')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  assignReport(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignCaseDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'report.assign',
      entityType: 'report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.cases.assign('reports', id, dto.adminId ?? admin.adminId),
    });
  }

  @Post('reports/:id/escalate')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  escalateReport(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'report.escalate',
      entityType: 'report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: () => this.cases.escalate('reports', id, admin.adminId),
    });
  }

  @Post('reports/:id/notes')
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto, { status: 201 })
  @ApiErrors(400, 403, 404)
  reportNote(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CaseNoteDto) {
    return this.cases.addNote('report', id, admin.adminId, dto.body);
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async resolveReport(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveReportDto, @ReqCtx() ctx: RequestContext) {
    const r = await this.actions.run({
      admin,
      action: 'report.resolve',
      entityType: 'report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { outcome: dto.outcome },
      execute: () => this.reports.adminResolve(id, { outcome: dto.outcome, resolution: dto.resolution }, { adminId: admin.adminId }),
    });
    return { id: r.id, status: r.status };
  }

  // ---- No-show reports ----

  @Get('no-shows')
  @AdminAuth('REPORTS_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(400)
  noShowQueue(@Query() query: NoShowListQueryDto) {
    return this.cases.noShows(query);
  }

  @Post('no-shows/:id/resolve')
  @HttpCode(200)
  @AdminAuth('REPORTS_MANAGE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404, 409)
  async resolveNoShow(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveNoShowDto, @ReqCtx() ctx: RequestContext) {
    const r = await this.actions.run({
      admin,
      action: 'no_show.resolve',
      entityType: 'no_show_report',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { outcome: dto.outcome },
      execute: () => this.noShows.adminResolve(id, dto.outcome, { adminId: admin.adminId }, dto.reasonText ?? dto.reasonCode),
    });
    return { id: r.id, status: r.status };
  }

  // ---- Ratings ----

  @Get('ratings')
  @AdminAuth('RATINGS_MODERATE')
  @ApiEnveloped(AnyObjectDto, { isArray: true })
  @ApiErrors(400)
  ratings(@Query() query: RatingListQueryDto) {
    return this.cases.ratings(query);
  }

  @Post('ratings/:id/moderate')
  @HttpCode(200)
  @AdminAuth('RATINGS_MODERATE')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  moderateRating(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ModerateRatingDto, @ReqCtx() ctx: RequestContext) {
    return this.actions.run({
      admin,
      action: 'rating.moderate',
      entityType: 'rating',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      metadata: { status: dto.status },
      execute: () => this.ratingService.adminModerate(id, dto.status, { adminId: admin.adminId }, dto.reasonText ?? dto.reasonCode),
    });
  }

  // ---- Messages ----

  /** A conversation's messages. Needs CHAT_SENSITIVE_VIEW and a reason; audited before the content is returned. */
  @Get('conversations/:id/messages')
  @AdminAuth('CHAT_SENSITIVE_VIEW')
  @ApiEnveloped(AnyObjectDto, { isArray: true, description: 'Oldest-first messages. Continue with meta.nextCursor; each page requires a reason and is audited.' })
  @ApiErrors(400, 403, 404)
  async conversation(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Query() query: ChatViewQueryDto, @ReqCtx() ctx: RequestContext) {
    await this.cases.conversationExists(id);
    await this.sensitive.record({
      admin,
      permission: 'CHAT_SENSITIVE_VIEW',
      resource: 'chat.conversation',
      entityType: 'conversation',
      entityId: id,
      reasonText: query.reasonCode,
      ctx,
    });
    return this.cases.messages(id, query.limit ?? 50, query.cursor);
  }

  /** Remove one message's content (the sender is told through enforcement). */
  @Post('messages/:id/remove')
  @HttpCode(200)
  @AdminAuth('CHAT_SENSITIVE_VIEW', 'ENFORCEMENT_APPLY')
  @ApiEnveloped(AnyObjectDto)
  @ApiErrors(400, 403, 404)
  async removeMessage(@CurrentAdmin() admin: AuthenticatedAdmin, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActionDto, @ReqCtx() ctx: RequestContext) {
    const senderId = await this.cases.messageSender(id);
    return this.actions.run({
      admin,
      action: 'message.remove',
      entityType: 'message',
      entityId: id,
      reason: { code: dto.reasonCode, text: dto.reasonText },
      ctx,
      execute: async () => {
        const action = await this.enforcement.adminApply(
          { userId: senderId, type: 'CONTENT_REMOVAL', reason: dto.reasonText ?? dto.reasonCode, content: { type: 'MESSAGE', id } },
          { adminId: admin.adminId },
        );
        return { removed: true, enforcementActionId: action.id };
      },
    });
  }
}
