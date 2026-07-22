/**
 * EP-014 — Generate simple static icons (no external deps).
 * Teal mark on dark/light ground for Personal Timeline.
 */

const zlib = require("zlib");

const THEME = {
  accent: [12, 107, 102, 255], // #0c6b66
  ink: [24, 32, 40, 255],
  paper: [243, 245, 242, 255],
};

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writeRgbaPng(width, height, rgba) {
  const signature = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter none
    rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function setPixel(rgba, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const i = (y * width + x) * 4;
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = color[3];
}

function fillRect(rgba, width, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      setPixel(rgba, width, x, y, color);
    }
  }
}

function fillCircle(rgba, width, cx, cy, r, color) {
  const r2 = r * r;
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(rgba, width, x, y, color);
    }
  }
}

/**
 * Draw a simple "PT" mark: rounded tile + vertical bar + dot.
 */
function renderIconRgba(size) {
  const rgba = Buffer.alloc(size * size * 4);
  // background
  fillRect(rgba, size, 0, 0, size, size, THEME.paper);
  const pad = Math.round(size * 0.12);
  const inner = size - pad * 2;
  // rounded-ish tile via circle corners approximation: fill square then circles
  fillRect(rgba, size, pad, pad, inner, inner, THEME.accent);
  const r = Math.round(size * 0.08);
  // soften corners with paper circles outside... skip — keep solid tile

  // vertical stroke (like a timeline spine)
  const barW = Math.max(2, Math.round(size * 0.1));
  const barX = Math.round(size * 0.38);
  const barY = Math.round(size * 0.28);
  const barH = Math.round(size * 0.44);
  fillRect(rgba, size, barX, barY, barW, barH, THEME.paper);

  // node dots
  const dotR = Math.max(2, Math.round(size * 0.07));
  fillCircle(
    rgba,
    size,
    barX + Math.floor(barW / 2),
    barY,
    dotR,
    THEME.paper
  );
  fillCircle(
    rgba,
    size,
    barX + Math.floor(barW / 2),
    barY + Math.floor(barH / 2),
    dotR,
    THEME.paper
  );
  fillCircle(
    rgba,
    size,
    barX + Math.floor(barW / 2),
    barY + barH,
    dotR,
    THEME.paper
  );

  // horizontal ticks
  const tickW = Math.round(size * 0.22);
  fillRect(
    rgba,
    size,
    barX + barW,
    barY + Math.floor(barH / 2) - Math.floor(barW / 2),
    tickW,
    barW,
    THEME.paper
  );
  fillRect(
    rgba,
    size,
    barX + barW,
    barY + barH - Math.floor(barW / 2),
    Math.round(tickW * 0.7),
    barW,
    THEME.paper
  );

  return rgba;
}

function createPngIcon(size) {
  return writeRgbaPng(size, size, renderIconRgba(size));
}

/**
 * Minimal ICO containing one 32x32 PNG image.
 */
function createFaviconIco(png32) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = 32; // width
  entry[1] = 32; // height
  entry[2] = 0; // colors
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png32.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset

  return Buffer.concat([header, entry, png32]);
}

function generateSiteIcons() {
  const png192 = createPngIcon(192);
  const png512 = createPngIcon(512);
  const png180 = createPngIcon(180);
  const png32 = createPngIcon(32);
  const ico = createFaviconIco(png32);
  return {
    "icon-192.png": png192,
    "icon-512.png": png512,
    "apple-touch-icon.png": png180,
    "favicon.ico": ico,
  };
}

module.exports = {
  generateSiteIcons,
  createPngIcon,
  createFaviconIco,
  THEME_COLOR: "#0c6b66",
  BACKGROUND_COLOR: "#f3f5f2",
};
