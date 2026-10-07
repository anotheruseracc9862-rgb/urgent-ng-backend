/** Real image files for tests, optionally carrying GPS EXIF. No database or app dependencies. */

import sharp from 'sharp';

const GPS_EXIF = {
  IFD0: { Copyright: 'tester' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '6/1 27/1 0/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '3/1 23/1 0/1',
  },
};

interface ImageOptions {
  width?: number;
  height?: number;
  gps?: boolean;
  /** EXIF orientation 1-8 (6 = needs a 90 degree turn). */
  orientation?: number;
}

export async function makeImage(type: 'jpeg' | 'png' | 'webp', options: ImageOptions = {}): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: options.width ?? 800, height: options.height ?? 600, channels: 3, background: { r: 200, g: 30, b: 30 } },
  });
  if (type === 'jpeg') {
    pipeline = pipeline.jpeg();
  } else if (type === 'png') {
    pipeline = pipeline.png();
  } else {
    pipeline = pipeline.webp();
  }
  if (options.gps) {
    pipeline = pipeline.withExif(GPS_EXIF);
  }
  if (options.orientation) {
    pipeline = pipeline.withMetadata({ orientation: options.orientation });
  }
  return pipeline.toBuffer();
}

/**
 * True when the image carries a GPS block: the EXIF `GPSInfo` pointer (tag 0x8825) in IFD0.
 * A small TIFF reader, so the test does not trust the same library that wrote the file.
 */
export async function hasGpsData(image: Buffer): Promise<boolean> {
  const meta = await sharp(image).metadata();
  const exif = meta.exif;
  if (!exif) return false;
  const start = exif.subarray(0, 4).toString('latin1') === 'Exif' ? 6 : 0;
  const tiff = exif.subarray(start);
  const little = tiff.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd0 = u32(4);
  const count = u16(ifd0);
  for (let i = 0; i < count; i += 1) {
    if (u16(ifd0 + 2 + i * 12) === 0x8825) return true;
  }
  return false;
}
