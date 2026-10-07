import type { MediaPurpose } from '@prisma/client';

/** Image types accepted for upload (Backend PRD 23.2), with the file extension used in storage. */
export const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type ImageMime = keyof typeof ALLOWED_IMAGE_TYPES;

export const isAllowedImageType = (mime: string): mime is ImageMime =>
  Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_TYPES, mime);

/** A user may hold at most this many uploads that were requested but not yet confirmed. */
export const MAX_PENDING_UPLOADS = 20;

export const THUMBNAIL_SIZE = 320;

/** Decoded images above this many pixels are rejected before decoding (decompression-bomb guard). */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Job name and outbox event type for "an upload was confirmed and needs processing". */
export const MEDIA_CONFIRMED_EVENT = 'media.confirmed';

/** Reasons stored in `media.rejection_reason`. Stable codes, safe to show to the owner. */
export const REJECTION = {
  OBJECT_MISSING: 'OBJECT_MISSING',
  TOO_LARGE: 'TOO_LARGE',
  NOT_AN_IMAGE: 'NOT_AN_IMAGE',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  CORRUPT_IMAGE: 'CORRUPT_IMAGE',
  TOO_MANY_PIXELS: 'TOO_MANY_PIXELS',
  MODERATION: 'MODERATION',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  UPLOAD_MISMATCH: 'UPLOAD_MISMATCH',
} as const;

export type RejectionReason = (typeof REJECTION)[keyof typeof REJECTION];

/**
 * Storage keys always contain the owner and the purpose (Backend Build Plan P3-01):
 * `media/{ownerId}/{purpose}/{mediaId}/{file}`.
 */
export const mediaKeys = {
  original: (ownerId: string, purpose: MediaPurpose, id: string, extension: string) =>
    `media/${ownerId}/${purpose.toLowerCase()}/${id}/original.${extension}`,
  full: (ownerId: string, purpose: MediaPurpose, id: string, extension: string) =>
    `media/${ownerId}/${purpose.toLowerCase()}/${id}/full.${extension}`,
  thumbnail: (ownerId: string, purpose: MediaPurpose, id: string) =>
    `media/${ownerId}/${purpose.toLowerCase()}/${id}/thumb.webp`,
};
