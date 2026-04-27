/**
 * Task #83 — deterministic mock PNG generator.
 *
 * Pure helper extracted from `imageProviderBridge.ts` so the unit tests
 * can import it without dragging in the DB / uploads pipeline. The
 * generator produces a real, valid PNG byte stream (8x8 RGBA, with
 * spec-compliant signature, IHDR/IDAT/IEND chunks, and CRC-32
 * checksums) whose pixel colors are derived from sha256(prompt).
 *
 * Different prompts produce visibly different mock outputs which lets
 * the round-trip e2e meaningfully assert "the bytes changed when the
 * prompt changed" without ever needing live API keys.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const WIDTH = 8;
const HEIGHT = 8;

export function generateMockPng(prompt: string): Buffer {
  const hash = createHash("sha256").update(prompt).digest();

  // RGBA raw data: 4 bytes per pixel + 1 filter byte per row.
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  let offset = 0;
  for (let y = 0; y < HEIGHT; y++) {
    raw[offset++] = 0; // filter type "None" — keeps the encoder small + valid.
    for (let x = 0; x < WIDTH; x++) {
      // Mix prompt-hash bytes with the pixel index so the image is unique
      // per prompt yet structured (not pure noise — the user sees a
      // mosaic-like pattern that clearly looks intentional, not corrupted).
      const i = (y * WIDTH + x) % hash.length;
      raw[offset++] = hash[i] ?? 0;
      raw[offset++] = hash[(i + 7) % hash.length] ?? 0;
      raw[offset++] = hash[(i + 13) % hash.length] ?? 0;
      raw[offset++] = 0xff;
    }
  }

  const idatPayload = deflateSync(raw);

  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk: 13-byte payload (width, height, bit depth, color type, compression, filter, interlace)
  const ihdrPayload = Buffer.alloc(13);
  ihdrPayload.writeUInt32BE(WIDTH, 0);
  ihdrPayload.writeUInt32BE(HEIGHT, 4);
  ihdrPayload[8] = 8; // bit depth
  ihdrPayload[9] = 6; // color type: RGBA
  ihdrPayload[10] = 0; // compression
  ihdrPayload[11] = 0; // filter
  ihdrPayload[12] = 0; // no interlace

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrPayload),
    pngChunk("IDAT", idatPayload),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const MOCK_PNG_DIMENSIONS = { width: WIDTH, height: HEIGHT };

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, payload, crc]);
}

// Standard CRC-32 (polynomial 0xedb88320), required by the PNG spec.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
