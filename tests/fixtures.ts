/** Generates the JPEG fixtures the suites read. Pure Node — no image library. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Writes a baseline JPEG with the given dimensions. The scan data is a single
 * grey MCU repeated — these fixtures exist to be measured, not looked at.
 */
function jpeg(width: number, height: number, progressive = false): Buffer {
  const seg = (marker: number, payload: Buffer) =>
    Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
  const be16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);

  const qt = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x10)]);
  const sof = Buffer.concat([
    Buffer.from([0x08]), be16(height), be16(width), Buffer.from([0x01]),
    Buffer.from([0x01, 0x11, 0x00]),
  ]);
  // A minimal but structurally valid Huffman table.
  const dht = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  ]);
  const sos = Buffer.concat([Buffer.from([0x01, 0x01, 0x00]), Buffer.from([0x00, 0x3f, 0x00])]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([Buffer.from("JFIF\0"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    seg(0xdb, qt),
    seg(progressive ? 0xc2 : 0xc0, sof),
    seg(0xc4, dht),
    seg(0xda, sos),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

export const FIXTURES: Record<string, [number, number]> = {
  "square_1080.jpg": [1080, 1080],
  "portrait_1080x1350.jpg": [1080, 1350],
  "landscape_1080x566.jpg": [1080, 566],
  "too_tall_1080x1920.jpg": [1080, 1920],
  "too_wide_1920x600.jpg": [1920, 600],
};

export function writeFixtures(): string {
  mkdirSync(DIR, { recursive: true });
  for (const [name, [w, h]] of Object.entries(FIXTURES)) {
    writeFileSync(resolve(DIR, name), jpeg(w, h));
  }
  writeFileSync(resolve(DIR, "progressive.jpg"), jpeg(800, 800, true));
  // A PNG, to prove the reader refuses non-JPEG input.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(640, 0); ihdr.writeUInt32BE(480, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  writeFileSync(
    resolve(DIR, "notajpeg.png"),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.alloc(16))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
  return DIR;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(writeFixtures());
