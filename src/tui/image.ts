/**
 * T7: image render trong chat — detect terminal protocol + halfblock preview.
 * Không thêm dependency: halfblock qua unicode upper-half ▀ với truecolor
 * (iTerm2/kitty hỗ trợ COLORTERM=truecolor). Terminal không hỗ trợ → fallback
 * link text. ponytail: 40px width cố định, không đo cell size thật — nâng
 * cấp khi cần aspect ratio chuẩn.
 */
import { inflateSync } from "node:zlib";
export interface TermImageCaps {
  /** truecolor (COLORTERM=truecolor/24bit) — bắt buộc cho halfblock. */
  truecolor: boolean;
  /** iTerm2 inline images protocol (ESC]1337). */
  iterm: boolean;
  /** kitty graphics protocol. */
  kitty: boolean;
}

export function detectImageCaps(env: NodeJS.ProcessEnv = process.env): TermImageCaps {
  const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
  const iterm = env.TERM_PROGRAM === "iTerm.app";
  const kitty = env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID !== undefined;
  return { truecolor, iterm, kitty };
}

const IMG_MAGIC: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: "png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 },
  { ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 },
  { ext: "gif", test: (b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF" },
  { ext: "bmp", test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];

/** Detect image từ magic bytes (đuôi file không đáng tin). */
export function detectImageBytes(buf: Buffer): string | null {
  return IMG_MAGIC.find((m) => m.test(buf))?.ext ?? null;
}

/** Decode PNG/JPG size (width/height) — chỉ PNG (IHDR) và JPEG (SOF markers). */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (detectImageBytes(buf) === "png" && buf.length > 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (detectImageBytes(buf) === "jpg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export interface HalfblockRow {
  /** Chữ "▀" với fg = pixel trên, bg = pixel dưới. */
  text: string;
}

/**
 * Render buffer ảnh thành mảng dòng "▀" (2 pixel ảnh / 1 dòng terminal).
 * Trả về null khi terminal không truecolor (caller fallback link).
 */
export function halfblockRows(buf: Buffer, maxCols = 40): HalfblockRow[] | null {
  const png = detectImageBytes(buf) === "png";
  if (!png) return null; // ponytail: chỉ decode PNG thuần (zlib builtin); JPG → null
  const size = imageSize(buf);
  if (!size || size.width === 0 || size.height === 0) return null;
  // Decode IDAT: zlib inflate + unfilter scanlines.
  let rows: Uint8Array;
  try {
    rows = decodePngPixels(buf, size.width, size.height);
  } catch {
    return null;
  }
  const w = size.width;
  const cols = Math.min(maxCols, w);
  const step = w / cols; // downsample theo cột
  const out: HalfblockRow[] = [];
  for (let py = 0; py < size.height; py += 2) {
    let line = "";
    for (let cx = 0; cx < cols; cx++) {
      const px = Math.min(w - 1, Math.floor(cx * step));
      const top = pixelAt(rows, w, px, py);
      const bot = py + 1 < size.height ? pixelAt(rows, w, px, py + 1) : [0, 0, 0];
      line += `\x1b[38;2;${top[0]};${top[1]};${top[2]};48;2;${bot[0]};${bot[1]};${bot[2]}m▀`;
    }
    out.push({ text: line + "\x1b[0m" });
  }
  return out;
}

function pixelAt(rows: Uint8Array, w: number, x: number, y: number): [number, number, number] {
  const o = (y * w + x) * 3;
  return [rows[o], rows[o + 1], rows[o + 2]];
}

/** PNG IDAT decode (zlib builtin) + unfilter — RGB/RGBA 8-bit không interlace. */
function decodePngPixels(buf: Buffer, w: number, h: number): Uint8Array {
  // Scan chunks: gather IDAT data.
  let off = 8;
  const idat: Buffer[] = [];
  let bitDepth = 8;
  let colorType = 2;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      bitDepth = buf[off + 16];
      colorType = buf[off + 17];
    }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error("unsupported png");
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (f) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const so = x * bpp;
      const do_ = (y * w + x) * 3;
      px[do_] = cur[so];
      px[do_ + 1] = cur[so + 1];
      px[do_ + 2] = cur[so + 2];
    }
    prev = cur;
  }
  return px;
}
