import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";

const geometry = [
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

function renderIcon(size) {
  const supersample = 4;
  const workingSize = size * supersample;
  const scale = size / 64;
  const pixels = Buffer.alloc(workingSize * workingSize * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 11;
    pixels[index + 1] = 15;
    pixels[index + 2] = 26;
    pixels[index + 3] = 255;
  }
  const setPixel = (x, y) => {
    if (x < 0 || y < 0 || x >= workingSize || y >= workingSize) return;
    const index = (y * workingSize + x) * 4;
    pixels[index] = 166;
    pixels[index + 1] = 243;
    pixels[index + 2] = 111;
    pixels[index + 3] = 255;
  };
  const disc = (x, y, radius) => {
    for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py += 1) {
      for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px += 1) {
        if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) setPixel(px, py);
      }
    }
  };
  const line = (a, b, width) => {
    const x1 = a[0] * scale * supersample;
    const y1 = a[1] * scale * supersample;
    const x2 = b[0] * scale * supersample;
    const y2 = b[1] * scale * supersample;
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
    const radius = (width * scale * supersample) / 2;
    for (let step = 0; step <= steps; step += 1) {
      const amount = steps === 0 ? 0 : step / steps;
      disc(x1 + (x2 - x1) * amount, y1 + (y2 - y1) * amount, radius);
    }
  };
  for (const path of geometry) for (let index = 1; index < path.length; index += 1) line(path[index - 1], path[index], path === geometry[3] ? 4.5 : 5.5);
  let previous = [53, 10];
  for (let index = 1; index <= 180; index += 1) {
    const angle = -Math.PI / 2 - (Math.PI * index) / 180;
    const current = [53 + Math.cos(angle) * 22, 32 + Math.sin(angle) * 22];
    line(previous, current, 5.5);
    previous = current;
  }
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0);
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < supersample; sy += 1) for (let sx = 0; sx < supersample; sx += 1) {
        const index = ((y * supersample + sy) * workingSize + x * supersample + sx) * 4;
        totals[0] += pixels[index];
        totals[1] += pixels[index + 1];
        totals[2] += pixels[index + 2];
        totals[3] += pixels[index + 3];
      }
      rows.push(...totals.map((value) => Math.round(value / 16)));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

await writeFile("assets/icon-192.png", renderIcon(192));
await writeFile("assets/icon-512.png", renderIcon(512));
