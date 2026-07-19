import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public", "icons");
const source128 = path.join(output, "phosphene-128.png");
const source512 = path.join(output, "phosphene-512.png");

await fs.mkdir(output, { recursive: true });
const [metadata128, metadata512] = await Promise.all([
  sharp(source128).metadata(),
  sharp(source512).metadata()
]);

if (metadata128.width !== 128 || metadata128.height !== 128) {
  throw new Error("phosphene-128.png must be exactly 128 × 128 pixels.");
}

if (metadata512.width !== 512 || metadata512.height !== 512) {
  throw new Error("phosphene-512.png must be exactly 512 × 512 pixels.");
}

await sharp(source512)
  .resize(192, 192, { fit: "cover", kernel: sharp.kernel.lanczos3 })
  .png()
  .toFile(path.join(output, "phosphene-192.png"));

// The artwork already keeps its mark inside the maskable safe zone.
await fs.copyFile(source512, path.join(output, "phosphene-maskable-512.png"));

console.log("Generated Phosphene PWA icons.");
