import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RunnerModule } from '../runner/runner.module.js';
import { CommonModule } from '../common/common.module.js';
import { MarketplaceController, SavedErrandsController } from './marketplace.controller.js';
import { MarketplaceFeedService } from './marketplace-feed.service.js';
import { SavedErrandsService } from './saved-errands.service.js';
import { FeedRateLimiter } from './feed-rate-limiter.js';
import { MarketplaceMediaAccess } from './marketplace-media.access.js';
import { FEED_BOOST_SOURCE, NoBoostSource } from './feed-boost.hook.js';

/** Marketplace discovery (Backend PRD section 12): feed, map, detail and saved errands. */
@Module({
  imports: [AuthModule, MediaModule, RunnerModule, CommonModule],
  controllers: [MarketplaceController, SavedErrandsController],
  providers: [
    MarketplaceFeedService,
    SavedErrandsService,
    FeedRateLimiter,
    MarketplaceMediaAccess,
    { provide: FEED_BOOST_SOURCE, useClass: NoBoostSource },
  ],
  exports: [MarketplaceFeedService, SavedErrandsService, FEED_BOOST_SOURCE],
})
export class MarketplaceModule {}
