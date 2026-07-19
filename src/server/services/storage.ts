import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  MAX_PROOF_IMAGE_BYTES,
  MAX_PROOF_IMAGE_PIXELS,
  MAX_PROOF_IMAGES
} from "../../shared/constants";
import { config } from "../config";
import { AppError } from "../errors";
import { createId, sha256 } from "../lib/ids";

export interface StoredProof {
  id: string;
  objectKey: string;
  previewKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
}

export async function initializeStorage(): Promise<void> {
  await fs.mkdir(config.LOCAL_STORAGE_PATH, { recursive: true });
}

async function putObject(key: string, body: Buffer): Promise<void> {
  const target = path.join(config.LOCAL_STORAGE_PATH, ...key.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { flag: "wx" });
}

export async function putRestoredObject(
  key: string,
  body: Buffer,
  _contentType = "image/webp"
): Promise<void> {
  await putObject(key, body);
}

export async function getObject(key: string): Promise<Buffer> {
  try {
    return await fs.readFile(path.join(config.LOCAL_STORAGE_PATH, ...key.split("/")));
  } catch {
    throw new AppError(404, "asset_not_found", "Proof image not found");
  }
}

export async function deleteObject(key: string): Promise<void> {
  await fs.rm(path.join(config.LOCAL_STORAGE_PATH, ...key.split("/")), { force: true });
}

export async function saveProofImages(files: Express.Multer.File[]): Promise<StoredProof[]> {
  if (files.length > MAX_PROOF_IMAGES) {
    throw new AppError(
      413,
      "too_many_images",
      `A submission can contain at most ${MAX_PROOF_IMAGES} images`
    );
  }
  const stored: StoredProof[] = [];
  try {
    for (const file of files) {
      if (file.size > MAX_PROOF_IMAGE_BYTES) {
        throw new AppError(413, "image_too_large", "Each proof image must be 10 MB or smaller");
      }
      const image = sharp(file.buffer, {
        failOn: "warning",
        limitInputPixels: MAX_PROOF_IMAGE_PIXELS
      });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        !["jpeg", "png", "webp"].includes(metadata.format ?? "")
      ) {
        throw new AppError(
          415,
          "unsupported_image",
          "Only genuine JPEG, PNG, and WebP images are accepted"
        );
      }
      if (metadata.width * metadata.height > MAX_PROOF_IMAGE_PIXELS) {
        throw new AppError(
          413,
          "image_dimensions_too_large",
          "Image pixel dimensions are too large"
        );
      }

      // Re-encoding strips EXIF/GPS and normalizes orientation.
      const normalized = await image.rotate().webp({ quality: 90, effort: 4 }).toBuffer();
      const preview = await sharp(normalized)
        .resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toBuffer();
      const id = createId("proof");
      const objectKey = `proofs/${id}/original.webp`;
      const previewKey = `proofs/${id}/preview.webp`;
      await putObject(objectKey, normalized);
      await putObject(previewKey, preview);
      stored.push({
        id,
        objectKey,
        previewKey,
        mimeType: "image/webp",
        sizeBytes: normalized.byteLength,
        sha256: sha256(normalized),
        width: metadata.autoOrient?.width ?? metadata.width,
        height: metadata.autoOrient?.height ?? metadata.height
      });
    }
    return stored;
  } catch (error) {
    await Promise.allSettled(
      stored.flatMap((item) => [
        deleteObject(item.objectKey),
        deleteObject(item.previewKey)
      ])
    );
    throw error;
  }
}

export async function removeStoredProofs(items: StoredProof[]): Promise<void> {
  await Promise.allSettled(
    items.flatMap((item) => [
      deleteObject(item.objectKey),
      deleteObject(item.previewKey)
    ])
  );
}
