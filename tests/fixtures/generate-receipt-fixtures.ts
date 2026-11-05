import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

export const FIXTURES_DIR = path.resolve(
  import.meta.dirname ?? "tests/fixtures",
);

/**
 * Builds a minimal EXIF APP1 segment (big-endian TIFF) with an ASCII
 * description and an Orientation SHORT. Constructed by hand because
 * sharp's EXIF writer does not persist the Orientation tag in this
 * environment.
 */
function buildExifSegment(orientation: number, description: string): Buffer {
  const descBytes = Buffer.from(description, "ascii");
  const descDataLen = descBytes.length + 1; // null terminator
  const ifdSize = 2 + 2 * 12 + 4; // count + entries + next-IFD offset
  const tiff = Buffer.alloc(8 + ifdSize + descDataLen);

  tiff.write("MM", 0, "ascii"); // big-endian byte order
  tiff.writeUInt16BE(0x002a, 2); // TIFF magic
  tiff.writeUInt32BE(8, 4); // IFD0 offset

  let o = 8;
  tiff.writeUInt16BE(2, o); // two entries
  o += 2;
  // ImageDescription (0x010e), ASCII, stored after the IFD.
  tiff.writeUInt16BE(0x010e, o);
  tiff.writeUInt16BE(2, o + 2);
  tiff.writeUInt32BE(descDataLen, o + 4);
  tiff.writeUInt32BE(8 + ifdSize, o + 8);
  o += 12;
  // Orientation (0x0112), SHORT, count 1, value inline.
  tiff.writeUInt16BE(0x0112, o);
  tiff.writeUInt16BE(3, o + 2);
  tiff.writeUInt32BE(1, o + 4);
  tiff.writeUInt16BE(orientation, o + 8);
  tiff.writeUInt16BE(0, o + 10);
  o += 12;
  tiff.writeUInt32BE(0, o); // no next IFD
  descBytes.copy(tiff, 8 + ifdSize);
  tiff[8 + ifdSize + descBytes.length] = 0;

  const payload = Buffer.concat([
    Buffer.from("Exif\u0000\u0000", "ascii"),
    tiff,
  ]);
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1; // APP1 marker
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

/** Injects an APP1 segment right after the JPEG SOI marker. */
function injectExifSegment(jpeg: Buffer, segment: Buffer): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

export const JPEG_EXIF_MARKER = "kittie-exif-marker";
export const PNG_EXIF_MARKER = "kittie-png-exif-marker";

/**
 * Builds the JPEG fixture: 3000x2000 raw pixels with EXIF orientation 6, so
 * the stored re-encode must rotate (long edge becomes height) and resize
 * down to the 2000px cap. The marker text proves EXIF stripping.
 */
async function buildJpeg(): Promise<Buffer> {
  const base = await sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 237, g: 231, b: 255 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  return injectExifSegment(base, buildExifSegment(6, JPEG_EXIF_MARKER));
}

async function buildPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1500,
      height: 800,
      channels: 3,
      background: { r: 36, g: 31, b: 53 },
    },
  })
    .withMetadata({
      exif: {
        IFD0: {
          ImageDescription: PNG_EXIF_MARKER,
        },
      },
    })
    .png()
    .toBuffer();
}

export async function ensureFixtures(
  dir: string = FIXTURES_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const jpgPath = path.join(dir, "receipt.jpg");
  const pngPath = path.join(dir, "receipt.png");
  try {
    await sharp(jpgPath).metadata();
    await sharp(pngPath).metadata();
  } catch {
    await writeFile(jpgPath, await buildJpeg());
    await writeFile(pngPath, await buildPng());
  }
}

export async function buildJpegBuffer(): Promise<Buffer> {
  return buildJpeg();
}

export async function buildPngBuffer(): Promise<Buffer> {
  return buildPng();
}

if (import.meta.main) {
  await ensureFixtures();
  console.log(`wrote fixtures to ${FIXTURES_DIR}`);
}
