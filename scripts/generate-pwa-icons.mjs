import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public", "favicon.svg");
const output = path.join(root, "public", "icons");

await fs.mkdir(output, { recursive: true });
await sharp(source).resize(192, 192).png().toFile(path.join(output, "phosphene-192.png"));
await sharp(source).resize(512, 512).png().toFile(path.join(output, "phosphene-512.png"));

const maskableMark = await sharp(source).resize(358, 358).png().toBuffer();
await sharp({
  create: {
    width: 512,
    height: 512,
    channels: 4,
    background: "#17152b"
  }
})
  .composite([{ input: maskableMark, gravity: "center" }])
  .png()
  .toFile(path.join(output, "phosphene-maskable-512.png"));

console.log("Generated Phosphene PWA icons.");
