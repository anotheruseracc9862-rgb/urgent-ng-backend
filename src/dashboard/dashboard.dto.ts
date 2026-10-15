import { ApiProperty } from '@nestjs/swagger';

export class DashboardRequesterDto {
  @ApiProperty({ description: 'Errands created this month (Lagos time), drafts excluded.' })
  errandsThisMonth!: number;
  @ApiProperty({ description: 'Errands completed this month.' })
  completedThisMonth!: number;
  @ApiProperty({ description: 'Open errands that are published and not yet assigned.' })
  openErrands!: number;
  @ApiProperty({ description: 'Errands in progress with a runner.' })
  activeErrands!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Completed errands as a share of the errands that ended in the last 90 days (completed, cancelled, expired), 0 to 1. Null with no ended errands.',
  })
  successRate!: number | null;
  @ApiProperty({ description: 'Open errands that have offers waiting for a reply.' })
  errandsWithOffers!: number;
  @ApiProperty({ description: 'Offers on your open errands where the next move is yours.' })
  offersToReview!: number;
  @ApiProperty({ description: 'Errands where a runner was selected and has not accepted yet.' })
  awaitingRunnerAcceptance!: number;
  @ApiProperty({ description: 'Delivered errands waiting for you to confirm.' })
  deliveriesToConfirm!: number;
  @ApiProperty({ description: 'Change requests from a runner that you have not answered.' })
  changeRequestsToAnswer!: number;
  @ApiProperty({
    type: Number,
    isArray: true,
    description: 'Errands you published in each of the last four 7-day periods, oldest first (four numbers). Drafts excluded.',
  })
  errandsPerWeek!: number[];
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Average offers per errand you published in the last 90 days, one decimal. Null with none published.',
  })
  averageOffersPerErrand!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Median minutes from publishing to selecting a runner, over errands where you selected one in the last 90 days. Null without a sample.',
  })
  medianMinutesToSelect!: number | null;
}

export class OfferDayDto {
  @ApiProperty({ description: 'The day in Lagos time, YYYY-MM-DD.', example: '2026-10-15' })
  date!: string;
  @ApiProperty({ description: 'Offers you sent that day.' })
  sent!: number;
  @ApiProperty({ description: 'Times you were selected that day.' })
  selected!: number;
}

export class DashboardRunnerDto {
  @ApiProperty({ description: 'Assignments pending acceptance or accepted and not finished.' })
  activeAssignments!: number;
  @ApiProperty({ description: 'Assignments where you were selected and must accept or decline.' })
  selectedAwaitingYou!: number;
  @ApiProperty({ description: 'Your offers that are still active.' })
  activeOffers!: number;
  @ApiProperty({ description: 'Your active offers where the requester is waiting for you (a counter-offer or a reconfirmation).' })
  offersAwaitingYou!: number;
  @ApiProperty({ description: 'Offers you sent in the last 7 days.' })
  offersThisWeek!: number;
  @ApiProperty({ description: 'Assignments you completed in the last 30 days.' })
  completedLast30Days!: number;
  @ApiProperty({ description: 'Change requests from a requester that you have not answered.' })
  changeRequestsToAnswer!: number;
  @ApiProperty({ type: OfferDayDto, isArray: true, description: 'The last seven days in Lagos time, oldest first: offers sent and times selected.' })
  offersPerDay!: OfferDayDto[];
}

export class ActivityItemDto {
  @ApiProperty({ example: 'ERRAND_STATUS' })
  type!: string;
  @ApiProperty()
  errandId!: string;
  @ApiProperty()
  errandTitle!: string;
  @ApiProperty({ description: 'The status the errand moved to.' })
  status!: string;
  @ApiProperty({ enum: ['REQUESTER', 'RUNNER'], description: 'Your side of that errand.' })
  role!: string;
  @ApiProperty({ type: Date })
  at!: Date;
}

export class MeSummaryDto {
  @ApiProperty({ type: DashboardRequesterDto })
  asRequester!: DashboardRequesterDto;
  @ApiProperty({ type: DashboardRunnerDto })
  asRunner!: DashboardRunnerDto;
  @ApiProperty({ type: ActivityItemDto, isArray: true, description: 'The latest status changes on your errands, newest first.' })
  recentActivity!: ActivityItemDto[];
}
