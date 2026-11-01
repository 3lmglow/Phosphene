import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "assets", "brand", "phosphene-stars-source.jpg");
const output = path.join(root, "public", "icons");

// The source artwork draws two small stars on a flat blue field with a lot of empty
// space around them. Find the stars, then crop squares around them so the mark fills
// each icon instead of floating in the middle of it.
const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
const luma = (x, y) => {
  const offset = (y * width + x) * channels;
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
};

const field = [luma(8, 8), luma(width - 9, 8), luma(8, height - 9), luma(width - 9, height - 9)];
const threshold = Math.max(...field) + 90;
let left = width;
let right = -1;
let top = height;
let bottom = -1;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (luma(x, y) > threshold) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
}
if (right < 0) throw new Error("No stars found in the brand source image.");

const centerX = (left + right) / 2;
const centerY = (top + bottom) / 2;
const extent = Math.max(right - left, bottom - top);

async function icon(size, fill, file) {
  const side = Math.min(width, height, Math.round(extent / fill));
  const crop = {
    left: Math.round(Math.min(width - side, Math.max(0, centerX - side / 2))),
    top: Math.round(Math.min(height - side, Math.max(0, centerY - side / 2))),
    width: side,
    height: side
  };
  await sharp(source)
    .extract(crop)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(path.join(output, file));
}

await fs.mkdir(output, { recursive: true });
await icon(128, 0.6, "phosphene-stars-128.png");
await icon(192, 0.6, "phosphene-stars-192.png");
await icon(512, 0.6, "phosphene-stars-512.png");
// Maskable icons may be cropped to a circle of 80% diameter; leave the stars more room.
await icon(512, 0.46, "phosphene-stars-maskable-512.png");

console.log(`Generated Phosphene PWA icons (stars ${right - left}×${bottom - top} at ${Math.round(centerX)},${Math.round(centerY)}).`);
