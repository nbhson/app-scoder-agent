/**
 * T7: image detect + halfblock render (module thuần, không terminal thật).
 * Chạy: node --test test/tui-image.test.mjs (sau khi npm run build)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectImageCaps, detectImageBytes, imageSize, halfblockRows } from "../dist/tui/image.js";
import { deflateSync } from "node:zlib";

describe("detectImageCaps (T7)", () => {
  it("truecolor + iterm + kitty", () => {
    assert.deepEqual(detectImageCaps({ COLORTERM: "truecolor", TERM_PROGRAM: "iTerm.app" }), { truecolor: true, iterm: true, kitty: false });
    assert.deepEqual(detectImageCaps({ TERM: "xterm-kitty" }), { truecolor: false, iterm: false, kitty: true });
    assert.deepEqual(detectImageCaps({ TERM: "dumb" }), { truecolor: false, iterm: false, kitty: false });
  });
});

describe("detectImageBytes + imageSize (T7)", () => {
  it("magic bytes png/jpg/gif; text → null", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(20).fill(0)]);
    assert.equal(detectImageBytes(png), "png");
    assert.equal(detectImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
    assert.equal(detectImageBytes(Buffer.from("hello world")), null);
  });

  it("imageSize PNG IHDR", () => {
    const png = Buffer.alloc(33);
    png[0] = 0x89; png[1] = 0x50;
    png.writeUInt32BE(16, 16); // width 16
    png.writeUInt32BE(9, 20); // height 9
    assert.deepEqual(imageSize(png), { width: 16, height: 9 });
  });
});

// Tạo PNG RGB 8-bit 2x2 thật (IHDR + IDAT + IEND) để test halfblock decode.
function makePng(width, height, rgbAt) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("halfblockRows (T7)", () => {
  it("PNG 2x2 đỏ/xanh → 1 dòng ▀ với escape truecolor", () => {
    const png = makePng(2, 2, (x, y) => (y === 0 ? [255, 0, 0] : [0, 0, 255]));
    const rows = halfblockRows(png);
    assert.ok(rows, "decode được");
    assert.equal(rows.length, 1); // 2 pixel height / 2 = 1 row
    assert.match(rows[0].text, /▀/);
    assert.match(rows[0].text, /38;2;255;0;0/); // fg top = đỏ
    assert.match(rows[0].text, /48;2;0;0;255/); // bg bottom = xanh
  });

  it("terminal không decode được (jpg) → null (fallback link)", () => {
    assert.equal(halfblockRows(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), null);
  });

  it("text buffer → null, không crash", () => {
    assert.equal(halfblockRows(Buffer.from("not an image")), null);
  });
});
