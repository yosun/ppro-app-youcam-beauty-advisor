// Prepares a photo in the browser before it is sent: upright, at most 2048 px
// on the long side, re-encoded as JPEG (which also drops EXIF and GPS). The
// server re-validates and re-encodes everything it receives; doing this first
// just keeps uploads small. If the browser cannot decode the image the
// original is sent and the server decides.

const MAX_SIDE = 2048;

/** The size an image of `width` x `height` is scaled to. Never enlarges. */
export function scaledSize(width: number, height: number, max = MAX_SIDE) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function preparePhoto(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    // Flatten transparency onto white, as the server does.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    return jpeg ?? file;
  } catch {
    return file;
  }
}
