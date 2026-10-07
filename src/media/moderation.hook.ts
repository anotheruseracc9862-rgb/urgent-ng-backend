import { Injectable } from '@nestjs/common';
import type { MediaPurpose } from '@prisma/client';

export type ModerationDecision =
  /** Nothing to report. The media stays at moderation status NONE. */
  | { decision: 'ALLOW' }
  /** Publish the media but queue it for a human to look at (moderation status FLAGGED). */
  | { decision: 'FLAG'; reason?: string }
  /** Do not publish (media is REJECTED, moderation status REMOVED). */
  | { decision: 'REJECT'; reason?: string };

export interface ModerationInput {
  mediaId: string;
  ownerId: string;
  purpose: MediaPurpose;
  /** The processed image, with metadata already removed. */
  image: Buffer;
}

/**
 * The moderation hook (Backend PRD 23.2). Phase 3 ships a pass-through; an image-moderation
 * vendor replaces `NoopModerationHook` by providing this token in MediaModule.
 */
export interface IMediaModerationHook {
  review(input: ModerationInput): Promise<ModerationDecision>;
}

export const MEDIA_MODERATION_HOOK = Symbol('MEDIA_MODERATION_HOOK');

@Injectable()
export class NoopModerationHook implements IMediaModerationHook {
  async review(): Promise<ModerationDecision> {
    return { decision: 'ALLOW' };
  }
}
