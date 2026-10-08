/**
 * Which errands are boosted right now (Backend PRD 12.4, 22.5). A boosted errand is pinned above
 * the normal results, at most `FEED_MAX_PINNED_BOOSTS_PER_PAGE` of them. Boosts arrive in Phase 10,
 * which replaces the no-op below with a lookup of active boosts. The feed still applies every
 * filter, the runner's operating area and the safety rules to a boosted errand.
 */
export interface FeedBoostSource {
  /** Ids of errands with an active boost at this moment (database time). */
  activeBoostedErrandIds(): Promise<string[]>;
}

export const FEED_BOOST_SOURCE = Symbol('FEED_BOOST_SOURCE');

export class NoBoostSource implements FeedBoostSource {
  async activeBoostedErrandIds(): Promise<string[]> {
    return [];
  }
}
