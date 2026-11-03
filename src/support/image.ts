import { createHash } from "node:crypto";
import sharp from "sharp";
import { ApiError } from "../protocol/errors.ts";
import { LIMITS } from "../protocol/constants.ts";

// Everything a client uploads is untrusted bytes. This module is the only
// place they are decoded. It identifies the format from the raw bytes (never
// the filename or Content-Type), refuses abusive declared sizes *before* a
// decoder allocates for them, then re-encodes the pixels so the stored copy
// carries no EXIF/GPS/XMP, no embedded payloads and no alpha channel.

const MAX_SIDE = 12_000;
const MAX_PIXELS = 25_000_000;

export type ImageFormat = "jpeg" | "png" | "webp";
export type SniffedImage = {
  format: ImageFormat;
  width: number;
  height: number;
  animated: boolean;
};

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));
const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function pngInfo(b: Uint8Array): SniffedImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || signature.some((byte, index) => b[index] !== byte))
    return null;
  // A conforming PNG always opens with IHDR, which carries the dimensions.
  if (ascii(b, 12, 16) !== "IHDR") return null;
  const data = view(b);
  const width = data.getUint32(16);
  const height = data.getUint32(20);
  return width && height
    ? { format: "png", width, height, animated: false }
    : null;
}

function jpegInfo(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    let marker = b[at + 1];
    // Any number of 0xFF fill bytes may precede a marker.
    while (marker === 0xff && at + 2 < b.length) {
      at++;
      marker = b[at + 1];
    }
    at += 2;
    // Markers that stand alone, with no length field.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    // Image data starts without a frame header: not a usable JPEG.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > b.length) return null;
    const length = (b[at] << 8) | b[at + 1];
    if (length < 2) return null;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (at + 7 > b.length) return null;
      const height = (b[at + 3] << 8) | b[at + 4];
      const width = (b[at + 5] << 8) | b[at + 6];
      return width && height
        ? { format: "jpeg", width, height, animated: false }
        : null;
    }
    at += length;
  }
  return null;
}

function webpInfo(b: Uint8Array): SniffedImage | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 12) !== "WEBP")
    return null;
  const chunk = ascii(b, 12, 16);
  const data = view(b);
  if (chunk === "VP8 ") {
    // Lossy: frame tag, 9D 01 2A start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    const width = data.getUint16(26, true) & 0x3fff;
    const height = data.getUint16(28, true) & 0x3fff;
    return width && height
      ? { format: "webp", width, height, animated: false }
      : null;
  }
  if (chunk === "VP8L") {
    // Lossless: 0x2F signature, then two 14-bit (size - 1) fields.
    if (b[20] !== 0x2f) return null;
    const bits = data.getUint32(21, true);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      animated: false,
    };
  }
  if (chunk === "VP8X") {
    // Extended: canvas size is two 24-bit (size - 1) fields; flag 0x02 = animation.
    return {
      format: "webp",
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      animated: (b[20] & 0x02) !== 0,
    };
  }
  return null;
}

/**
 * Identifies a JPEG, PNG or WebP from its leading bytes alone and reports the
 * dimensions it declares. Returns null for anything else, including truncated
 * files, so callers never hand an unrecognized blob to a decoder.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
}

export type NormalizedImage = {
  jpeg: Buffer;
  width: number;
  height: number;
  sha256: string;
  sourceFormat: ImageFormat;
};

export type NormalizeOptions = {
  maxUploadBytes?: number;
  maxSide?: number;
  maxStoredBytes?: number;
  minShortSide?: number;
  unreadableMessage?: string;
};

/**
 * Validates an upload and returns a clean JPEG: EXIF orientation applied and
 * then all metadata dropped, transparency flattened onto white, longest side
 * at most `maxSide`. Throws an ApiError a client can show.
 */
export async function normalizeImage(
  upload: Uint8Array,
  options: NormalizeOptions = {},
): Promise<NormalizedImage> {
  const maxUploadBytes = options.maxUploadBytes ?? LIMITS.photoUploadBytes;
  const maxSide = options.maxSide ?? LIMITS.photoMaxSide;
  const maxStoredBytes = options.maxStoredBytes ?? LIMITS.storedImageBytes;
  const minShortSide = options.minShortSide ?? 0;
  const unreadable =
    options.unreadableMessage ??
    "That photo could not be read. Try a JPEG, PNG or WebP selfie.";
  if (!upload.byteLength)
    throw new ApiError(400, "invalid_request", "Choose a photo to upload.");
  if (upload.byteLength > maxUploadBytes)
    throw new ApiError(
      413,
      "payload_too_large",
      `That photo is too large. Try one under ${Math.floor(maxUploadBytes / (1024 * 1024))} MB.`,
    );
  const sniffed = sniffImage(upload);
  if (!sniffed)
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Upload a JPEG, PNG or WebP photo.",
    );
  if (sniffed.animated)
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Animated images aren’t supported. Upload a still photo.",
    );
  if (Math.min(sniffed.width, sniffed.height) < minShortSide)
    throw new ApiError(
      422,
      "photo_rejected",
      `That photo is too small. Use one at least ${minShortSide} pixels on its shorter side.`,
    );
  if (
    Math.max(sniffed.width, sniffed.height) > MAX_SIDE ||
    sniffed.width * sniffed.height > MAX_PIXELS
  )
    throw new ApiError(
      413,
      "payload_too_large",
      "That photo has too many pixels. Try a smaller one.",
    );
  let jpeg: Buffer;
  try {
    jpeg = await sharp(upload, {
      limitInputPixels: MAX_PIXELS,
      failOn: "error",
      animated: false,
    })
      // Apply EXIF orientation first; sharp then drops all metadata because
      // withMetadata() is never called.
      .rotate()
      .resize({
        width: maxSide,
        height: maxSide,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new ApiError(422, "photo_rejected", unreadable);
  }
  const encoded = sniffImage(jpeg);
  if (!encoded || encoded.format !== "jpeg" || jpeg.byteLength > maxStoredBytes)
    throw new ApiError(422, "photo_rejected", unreadable);
  return {
    jpeg,
    width: encoded.width,
    height: encoded.height,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
    sourceFormat: sniffed.format,
  };
}
