import { Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { RunnerModule } from '../runner/runner.module.js';
import { CommonModule } from '../common/common.module.js';
import { MarketplaceController, SavedErrandsController } from './marketplace.controller.js';
import { MarketplaceFeedService } from './marketplace-feed.service.js';
import { SavedErrandsService } from './saved-errands.service.js';
import { FeedRateLimiter } from './feed-rate-limiter.js';
import { MarketplaceMediaAccess } from './marketplace-media.access.js';
import { FEED_BOOST_SOURCE } from './feed-boost.hook.js';
import { BoostsModule } from '../boosts/boosts.module.js';
import { BoostService } from '../boosts/boost.service.js';
import { NearbyMatchingHandler } from './nearby-matching.handler.js';
import { NearbyMatchingService } from './nearby-matching.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ConfigStoreModule } from '../config/config-store.module.js';
import { DatabaseModule } from '../database/database.module.js';

/** Marketplace discovery (Backend PRD section 12): feed, map, detail and saved errands. */
@Module({
  imports: [AuthModule, RiskModule, BoostsModule, MediaModule, RunnerModule, CommonModule, NotificationsModule, EntitlementsModule, QueueModule, ConfigStoreModule, DatabaseModule],
  controllers: [MarketplaceController, SavedErrandsController],
  providers: [
    MarketplaceFeedService,
    SavedErrandsService,
    FeedRateLimiter,
    MarketplaceMediaAccess,
    NearbyMatchingService,
    NearbyMatchingHandler,
    { provide: FEED_BOOST_SOURCE, useExisting: BoostService },
  ],
  exports: [MarketplaceFeedService, SavedErrandsService, FEED_BOOST_SOURCE],
})
export class MarketplaceModule {}
