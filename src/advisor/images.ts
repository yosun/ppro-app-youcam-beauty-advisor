import sharp from "sharp";
import { normalizeImage, sniffImage } from "../support/image.ts";

// Image helpers specific to this app: the stand-in result image used in
// simulated mode, and the copy of a photo that is sent to YouCam.

/**
 * A stand-in result image for simulated mode: the client's own photo with a
 * translucent color wash, so a "before and after" visibly differs. It is not
 * a makeup rendering and the app labels every simulated result as such.
 */
export async function simulatedResultImage(
  jpeg: Uint8Array,
  hex: string,
  alpha = 0.22,
): Promise<Buffer> {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const meta = await sharp(jpeg).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  return sharp(jpeg)
    .composite([
      {
        input: {
          create: {
            width,
            height,
            channels: 4,
            background: {
              r: (value >> 16) & 255,
              g: (value >> 8) & 255,
              b: value & 255,
              alpha,
            },
          },
        },
        blend: "over",
      },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** YouCam's makeup try-on rejects sources of 1920x1080 and up; its SD skin
 * analysis needs only a 480-pixel short side. One copy of at most 1024 pixels
 * on its long side works for every tool here. */
export const YOUCAM_SOURCE_MAX_SIDE = 1024;

/** The photo scaled down for upload to YouCam, or unchanged when small enough. */
export async function youcamSourceJpeg(jpeg: Buffer): Promise<Buffer> {
  const size = sniffImage(jpeg);
  if (size && Math.max(size.width, size.height) <= YOUCAM_SOURCE_MAX_SIDE)
    return jpeg;
  return (
    await normalizeImage(jpeg, {
      maxUploadBytes: 12_000_000,
      maxSide: YOUCAM_SOURCE_MAX_SIDE,
      unreadableMessage: "That photo could not be prepared for YouCam.",
    })
  ).jpeg;
}
