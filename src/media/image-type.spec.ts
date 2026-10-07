import { describe, it, expect } from 'vitest';
import { detectImageType } from './image-type.js';
import { makeImage } from '../test/image.factory.js';

describe('detectImageType', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const)('recognises a real %s from its bytes', async (type, mime) => {
    expect(detectImageType(await makeImage(type, { width: 20, height: 20 }))).toBe(mime);
  });

  it('does not recognise text, scripts, SVG, GIF or empty files', () => {
    expect(detectImageType(Buffer.from('<?php echo 1; ?>'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('needs both RIFF and WEBP markers for WebP', () => {
    expect(detectImageType(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
  });
});
