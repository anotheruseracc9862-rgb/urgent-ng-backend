import { Module } from '@nestjs/common';
import { DevToolsController } from './dev-tools.controller.js';

/** Development helpers for the fake providers. Never imported when NODE_ENV is production. */
@Module({ controllers: [DevToolsController] })
export class DevToolsModule {}
