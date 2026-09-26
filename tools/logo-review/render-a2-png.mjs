import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const size = 512;
const supersample = 4;
const workingSize = size * supersample;
const geometryScale = size / 64;

const markPaths = [
  [[11, 10], [11, 54]],
  [[11, 32], [29.5, 13]],
  [[11, 32], [29.5, 51]],
  [[37, 28], [37, 36], [43, 36]],
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const label = Buffer.from(type, "ascii");
  const body = Buffer.concat([label, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, body, checksum]);
}

function setPixel(pixels, x, y, color, alpha = 255) {
  if (x < 0 || y < 0 || x >= workingSize || y >= workingSize) return;
  const index = (y * workingSize + x) * 4;
  pixels[index] = color[0];
  pixels[index + 1] = color[1];
  pixels[index + 2] = color[2];
  pixels[index + 3] = alpha;
}

function drawDisc(pixels, x, y, radius, color) {
  const minX = Math.floor(x - radius);
  const maxX = Math.ceil(x + radius);
  const minY = Math.floor(y - radius);
  const maxY = Math.ceil(y + radius);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) setPixel(pixels, px, py, color);
    }
  }
}

function drawLine(pixels, start, end, width, color) {
  const x1 = start[0] * geometryScale * supersample;
  const y1 = start[1] * geometryScale * supersample;
  const x2 = end[0] * geometryScale * supersample;
  const y2 = end[1] * geometryScale * supersample;
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  const radius = (width * geometryScale * supersample) / 2;
  for (let step = 0; step <= steps; step += 1) {
    const amount = steps === 0 ? 0 : step / steps;
    drawDisc(pixels, x1 + (x2 - x1) * amount, y1 + (y2 - y1) * amount, radius, color);
  }
}

function drawArc(pixels, width, color) {
  const radius = 22;
  const center = [53, 32];
  const steps = 180;
  let previous = [center[0], center[1] - radius];
  for (let index = 1; index <= steps; index += 1) {
    const angle = -Math.PI / 2 - (Math.PI * index) / steps;
    const current = [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
    drawLine(pixels, previous, current, width, color);
    previous = current;
  }
}

function render(background, foreground) {
  const pixels = Buffer.alloc(workingSize * workingSize * 4, 255);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = background[0];
    pixels[index + 1] = background[1];
    pixels[index + 2] = background[2];
  }
  for (const path of markPaths) {
    for (let index = 1; index < path.length; index += 1) drawLine(pixels, path[index - 1], path[index], path === markPaths[3] ? 4.5 : 5.5, foreground);
  }
  drawArc(pixels, 5.5, foreground);

  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0);
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const index = ((y * supersample + sy) * workingSize + x * supersample + sx) * 4;
          totals[0] += pixels[index];
          totals[1] += pixels[index + 1];
          totals[2] += pixels[index + 2];
          totals[3] += pixels[index + 3];
        }
      }
      rows.push(Math.round(totals[0] / 16), Math.round(totals[1] / 16), Math.round(totals[2] / 16), Math.round(totals[3] / 16));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

await mkdir("tools/logo-review", { recursive: true });
await writeFile("tools/logo-review/kantacue-a2-review-512.png", render([11, 17, 26], [166, 243, 111]));
await writeFile("tools/logo-review/kantacue-a2-white-512.png", render([255, 255, 255], [16, 24, 32]));
await writeFile("tools/logo-review/kantacue-a2-black-512.png", render([255, 255, 255], [0, 0, 0]));
