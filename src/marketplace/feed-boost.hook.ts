import { createHash } from 'node:crypto';
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

/**
 * More errands can be boosted than the feed has pinned slots. Rather than let the same few (the nearest, say) hold the slots
 * all day, the slots are given out by a rotation that changes every `ROTATION_MINUTES`: each boosted errand takes its turn,
 * so every requester who paid is seen. Within a window the choice is fixed, so paging does not shuffle, and the chosen
 * errands keep the order the runner's sort gave them.
 */
export const PIN_ROTATION_MINUTES = 10;

export function pinRotationBucket(now: Date = new Date()): number {
  return Math.floor(now.getTime() / (PIN_ROTATION_MINUTES * 60_000));
}

export function rotatePinned<T extends { id: string }>(rows: T[], slots: number, bucket: number): T[] {
  if (rows.length <= slots) return rows;
  const rank = (id: string) => createHash('md5').update(`${bucket}:${id}`).digest('hex');
  const chosen = new Set([...rows].sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, Math.max(0, slots)).map((row) => row.id));
  return rows.filter((row) => chosen.has(row.id));
}
