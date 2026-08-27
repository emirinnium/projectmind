import { deflateSync } from 'node:zlib';
import type { ScaleReport } from '../../core/scale/reporting/types.js';

// ---------------------------------------------------------------------------
// Dependency-free diagram rendering for `pm graph --format svg|png`.
//
// SVG is generated as plain XML (no external renderer). PNG is encoded from a
// raw RGBA pixel buffer by hand (IHDR/IDAT/IEND + CRC32), using node:zlib for
// the required deflate compression — zero npm dependencies. Labels are drawn
// with a compact 5x7 bitmap font so binary output stays readable offline.
// ---------------------------------------------------------------------------

const BACKGROUND: readonly [number, number, number] = [0xff, 0xff, 0xff];
const TITLE_COLOR: readonly [number, number, number] = [0x11, 0x18, 0x27];
const TEXT_COLOR: readonly [number, number, number] = [0x1f, 0x29, 0x37];
const PALETTE: readonly (readonly [number, number, number])[] = [
  [0x63, 0x66, 0xf1],
  [0x8b, 0x5c, 0xf6],
  [0xec, 0x48, 0x99],
  [0xf5, 0x9e, 0x0b],
  [0x10, 0xb9, 0x81],
  [0x3b, 0x82, 0xf6],
  [0xef, 0x44, 0x44],
  [0x14, 0xb8, 0xa6],
];

/** Classic 5x7 bitmap font (public-domain derived). Each glyph = 5 bytes,
 *  each byte = one column, bit n = row n (LSB = top row). */
const FONT5X7: Readonly<Record<string, readonly number[]>> = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
  '(': [0x00, 0x1c, 0x22, 0x41, 0x00],
  ')': [0x00, 0x41, 0x22, 0x1c, 0x00],
  '.': [0x00, 0x60, 0x60, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  '>': [0x41, 0x22, 0x14, 0x08, 0x00],
  '%': [0x23, 0x13, 0x08, 0x64, 0x62],
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
  '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x01, 0x01],
  G: [0x3e, 0x41, 0x41, 0x51, 0x32],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
};

function setPixel(buf: Uint8Array, width: number, x: number, y: number, color: readonly [number, number, number]): void {
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx + 2 >= buf.length) return;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
  buf[idx + 3] = 0xff;
}

function fillRect(buf: Uint8Array, width: number, height: number, x0: number, y0: number, w: number, h: number, color: readonly [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= height) break;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= width) break;
      setPixel(buf, width, x, y, color);
    }
  }
}

function drawText(buf: Uint8Array, width: number, x: number, y: number, text: string, color: readonly [number, number, number]): void {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT5X7[raw] ?? FONT5X7[' '];
    for (let col = 0; col < 5; col++) {
      const bits = glyph[col] ?? 0;
      for (let row = 0; row < 7; row++) {
        if (((bits >> row) & 1) === 1) {
          setPixel(buf, width, cx + col, y + row, color);
        }
      }
    }
    cx += 6;
  }
}

/** Length of the longest label that fits the 5x7 font on one line. */
function truncateLabel(label: string, maxWidth: number): string {
  const chars=Math.max(3, Math.floor(maxWidth / 6));
  return label.length > chars ? label.slice(0, chars - 1) + '~' : label;
}

/** Render the module landscape as a horizontal bar chart and encode it as PNG. */
export function renderModulePng(report: ScaleReport, width = 640): Buffer {
  const top = [...report.modules].sort((a, b) => b.fileCount - a.fileCount).slice(0, 12);
  const rowH = 26;
  const padTop = 40;
  const padBottom = 16;
  const height = padTop + top.length * rowH + padBottom;
  const buf = new Uint8Array(width * height * 4);
  fillRect(buf, width, height, 0, 0, width, height, BACKGROUND);
  drawText(buf, width, 12, 14, `ProjectMind - Module File Counts (${report.totalFiles} files)`, TITLE_COLOR);
  const maxFiles = Math.max(1, ...top.map((m) => m.fileCount));
  const barX = 150;
  const barMaxW = width - barX - 90;
  top.forEach((m, i) => {
    const y = padTop + i * rowH;
    const label = truncateLabel(m.name || m.path || '.', barX - 22);
    drawText(buf, width, 12, y + 2, label, TEXT_COLOR);
    const bw = Math.max(2, Math.round((m.fileCount / maxFiles) * barMaxW));
    fillRect(buf, width, height, barX, y, bw, 12, PALETTE[i % PALETTE.length]);
    drawText(buf, width, barX + bw + 6, y + 2, String(m.fileCount), TEXT_COLOR);
  });
  return encodePng(width, height, buf);
}

/** XML-escape attribute/text content. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render an interactive module diagram (boxes + file chips + tooltips) as SVG. */
export function renderModuleSvg(report: ScaleReport): string {
  const cols = 2;
  const pad = 24;
  const gap = 20;
  const boxW = 380;
  const chipPerRow = 2;
  const filesShown = 6;
  const headerH = 46;
  const chipRowH = 20;
  const legendH = 26;

  const byFiles = [...report.modules].sort((a, b) => b.fileCount - a.fileCount);
  const rows = Math.ceil(byFiles.length / cols) || 1;
  const colW = boxW + gap;
  const totalW = colW * cols - gap;
  const totalH = rows * 120; // generous row stride so boxes never overlap

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW + pad * 2}" height="${totalH + pad + legendH}" viewBox="0 0 ${totalW + pad * 2} ${totalH + pad + legendH}">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<text x="${pad}" y="${pad - 6}" font-family="monospace" font-size="14" font-weight="bold" fill="#111827">ProjectMind - Module Diagram (${report.totalFiles} files, ${report.modules.length} modules)</text>`);

  const groups: string[] = [];
  byFiles.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * colW;
    const y = pad + row * 120;
    const files = m.files.slice(0, filesShown);
    const extraFiles = m.files.length - files.length;
    const boxH = headerH + Math.ceil(files.length / chipPerRow) * chipRowH + 10;

    const elems: string[] = [];
    elems.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1"/>`);
    const name = m.name || m.path || '.';
    elems.push(`<text x="${x + 10}" y="${y + 22}" font-family="monospace" font-size="13" font-weight="bold" fill="#1e293b">${esc(name)}</text>`);
    elems.push(`<text x="${x + 10}" y="${y + 38}" font-family="monospace" font-size="11" fill="#64748b">${m.fileCount} files | ${m.cognitiveLoad.toFixed(2)} cog | ${Math.round(m.agentCoverage * 100)}% covered</text>`);
    files.forEach((f, fi) => {
      const chipX = x + 10 + (fi % chipPerRow) * ((boxW - 30) / chipPerRow);
      const chipY = y + headerH + Math.floor(fi / chipPerRow) * chipRowH;
      const fname = f.relativePath.split('/').pop() || f.path;
      elems.push(`<rect x="${chipX}" y="${chipY}" width="${(boxW - 30) / chipPerRow - 6}" height="15" rx="3" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1"/>`);
      elems.push(`<text x="${chipX + 4}" y="${chipY + 11}" font-family="monospace" font-size="10" fill="#4338ca">${esc(fname.slice(0, 28))}</text>`);
      elems.push(`<title>${esc(f.relativePath)}</title>`);
    });
    if (extraFiles > 0) {
      elems.push(`<text x="${x + 10}" y="${y + boxH - 2}" font-family="monospace" font-size="10" fill="#64748b">+${extraFiles} more files</text>`);
    }
    groups.push(`<g>${elems.join('')}</g>`);
  });

  parts.push(groups.join(''));
  parts.push(`<text x="${pad}" y="${totalH + pad + 18}" font-family="monospace" font-size="11" fill="#64748b">Tip: hover a chip for the full file path. Uncovered/hotspot modules appear first.</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function crc32(data: Buffer): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ ((c & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encode an RGBA pixel buffer as a true-color PNG (8-bit RGB, filter 0). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (stride + 1) + 1 + x * 3;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive (none used)
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}