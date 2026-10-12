import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth, ApiAdminAuth } from '../common/api/api-docs.js';
import { Idempotent } from '../common/idempotency/idempotent.decorator.js';
import { ConsumerAuth } from '../auth/decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ReqCtx } from '../auth/decorators/request-context.decorator.js';
import { AdminAuth, CurrentAdmin, type AuthenticatedAdmin } from '../admin/decorators/admin-auth.decorator.js';
import type { AdminRequestContext } from '../admin/admin-auth-event.service.js';
import { MeDto } from '../auth/dto/responses.dto.js';
import { MediaService } from './media.service.js';
import { MediaAccessService } from './media-access.service.js';
import { ProfilePhotoService } from './profile-photo.service.js';
import {
  MediaDto,
  MediaUrlDto,
  MediaUrlQueryDto,
  RequestUploadDto,
  SetProfilePhotoDto,
  UploadRequestResultDto,
} from './media.dto.js';

/** Upload flow and downloads (Backend PRD 30.3). */
@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly access: MediaAccessService,
  ) {}

  /** Step 1: declare the file (type and size) and get the upload route. Needs an `Idempotency-Key` so a retried request reuses the first answer. */
  @Post('uploads')
  @Idempotent({ operation: 'media-upload-request' })
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(UploadRequestResultDto, { status: 201 })
  @ApiErrors(400, 429)
  requestUpload(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestUploadDto) {
    return this.media.requestUpload(user.userId, dto);
  }

  /**
   * Step 2: send the file bytes here (`PUT`, body is the raw image, `Content-Type` is the declared
   * type, exact declared length). The backend stores it; the browser never contacts the bucket.
   */
  @Put(':id/content')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiBody({ description: 'The raw image bytes.', schema: { type: 'string', format: 'binary' }, required: true })
  @ApiConsumes('image/jpeg', 'image/png', 'image/webp')
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(400, 404, 409)
  async uploadContent(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request): Promise<void> {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType) throw new UnprocessableEntityException('Content-Type is required.');
    await this.media.uploadContent(user.userId, id, contentType, req);
  }

  /** Step 3: after the PUT, confirm. Safe to repeat. Poll `GET /media/:id` until `status` is READY or REJECTED. */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(MediaDto)
  @ApiErrors(400)
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.confirm(user.userId, id);
  }

  @Get(':id')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MediaDto)
  @ApiErrors(400)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.get(user.userId, id);
  }

  /** A short-lived signed URL, issued only if the caller may see this file. */
  @Get(':id/url')
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MediaUrlDto)
  @ApiErrors(400, 404, 409)
  url(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MediaUrlQueryDto,
  ) {
    return this.access.urlForUser(user.userId, id, query.variant ?? 'full');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth()
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(400, 409)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.media.remove(user.userId, id);
  }
}

/** The profile photo of the signed-in user. */
@ApiTags('Me')
@Controller('me/photo')
export class ProfilePhotoController {
  constructor(private readonly photos: ProfilePhotoService) {}

  @Put()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MeDto)
  @ApiErrors(400, 409)
  set(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetProfilePhotoDto) {
    return this.photos.set(user.userId, dto.mediaId);
  }

  @Delete()
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(MeDto)
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.photos.clear(user.userId);
  }
}

/** Admin download of any media. The permission needed depends on the purpose, and every view is audited. */
@ApiTags('Admin media')
@Controller('admin/media')
export class AdminMediaController {
  constructor(private readonly access: MediaAccessService) {}

  @Get(':id/url')
  @AdminAuth()
  @ApiAdminAuth()
  @ApiEnveloped(MediaUrlDto)
  @ApiErrors(400, 404, 409)
  url(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MediaUrlQueryDto,
    @ReqCtx() ctx: AdminRequestContext,
  ) {
    return this.access.urlForAdmin(admin, id, query.variant ?? 'full', ctx);
  }
}
