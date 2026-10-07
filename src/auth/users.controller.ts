import { ApiTags } from '@nestjs/swagger';
import { ApiEnveloped, ApiErrors, ApiConsumerAuth } from '../common/api/api-docs.js';
import * as R from './dto/responses.dto.js';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ConsumerAuth } from './decorators/consumer-auth.decorator.js';
import { CurrentUser, type AuthenticatedUser } from './decorators/current-user.decorator.js';
import { BlockService } from './block.service.js';
import { ProfileService } from './profile.service.js';

/** Other users (Backend PRD 30.1): the small public profile and blocking. */
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly profile: ProfileService,
    private readonly blocks: BlockService,
  ) {}

  @Get(':id')
  @ConsumerAuth({ allow: ['DEACTIVATED', 'SUSPENDED', 'DELETION_PENDING'] })
  @ApiConsumerAuth()
  @ApiEnveloped(R.PublicProfileDto)
  @ApiErrors(404)
  publicProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.profile.getPublic(id);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  @ApiErrors(400, 404)
  async block(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.blocks.block(user.userId, id);
  }

  @Delete(':id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ConsumerAuth({ allow: ['DEACTIVATED'] })
  @ApiConsumerAuth()
  @ApiEnveloped(null, { status: 204 })
  async unblock(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.blocks.unblock(user.userId, id);
  }
}
