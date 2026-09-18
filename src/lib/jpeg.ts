/**
 * Minimal JPEG dimension reader — walks the segment markers to the SOFn frame
 * header. Saves pulling in an image library just to pre-flight Instagram's
 * aspect-ratio rule.
 */
export interface Dimensions {
  width: number;
  height: number;
}

// SOF0-SOF15, excluding DHT (c4), DNL (c8) and DAC (cc) which share the range.
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function readJpegDimensions(buf: Buffer): Dimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not SOI

  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++; // resync over padding
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xda) break; // start of scan — no header past here
    offset += 2 + length;
  }
  return null;
}

/** Instagram accepts feed images between 4:5 (0.8) and 1.91:1. */
export const IG_MIN_RATIO = 0.8;
export const IG_MAX_RATIO = 1.91;

export function checkInstagramAspect(dim: Dimensions): { ok: boolean; ratio: number; hint?: string } {
  const ratio = dim.width / dim.height;
  if (ratio >= IG_MIN_RATIO && ratio <= IG_MAX_RATIO) return { ok: true, ratio };
  return {
    ok: false,
    ratio,
    hint:
      ratio < IG_MIN_RATIO
        ? `${dim.width}x${dim.height} is too tall (${ratio.toFixed(3)}:1). Instagram crops below 4:5 — use a 1080x1350 design.`
        : `${dim.width}x${dim.height} is too wide (${ratio.toFixed(3)}:1). Instagram crops above 1.91:1 — use a 1080x566 or 1080x1080 design.`,
  };
}
