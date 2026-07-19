import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  MAX_PROOF_IMAGE_BYTES,
  MAX_PROOF_IMAGE_PIXELS,
  MAX_PROOF_IMAGES
} from "../../shared/constants";
import { config } from "../config";
import { getDb } from "../db/client";
import { proofAssets } from "../db/schema";
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

const proofObjectKeyPattern =
  /^proofs\/proof_[A-Za-z0-9_-]+\/(original|preview)\.webp$/;

export function isValidProofObjectKey(key: string): boolean {
  return proofObjectKeyPattern.test(key);
}

export function getObjectPath(key: string): string {
  if (!isValidProofObjectKey(key)) {
    throw new AppError(400, "invalid_object_key", "Proof object key is invalid");
  }
  const root = path.resolve(config.LOCAL_STORAGE_PATH);
  const target = path.resolve(root, ...key.split("/"));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(400, "invalid_object_key", "Proof object key leaves private storage");
  }
  return target;
}

export async function initializeStorage(): Promise<void> {
  await Promise.all([
    fs.mkdir(config.LOCAL_STORAGE_PATH, { recursive: true }),
    fs.mkdir(config.BACKUP_TEMP_PATH, { recursive: true })
  ]);
  const temporaryFiles = await fs.readdir(config.BACKUP_TEMP_PATH, {
    withFileTypes: true
  });
  await Promise.allSettled(
    temporaryFiles
      .filter(
        (entry) =>
          entry.isFile() &&
          /^backup_upload_[A-Za-z0-9_-]+\.zip$/.test(entry.name)
      )
      .map((entry) =>
        fs.rm(path.join(config.BACKUP_TEMP_PATH, entry.name), { force: true })
      )
  );
}

export async function pruneOrphanedProofFiles(): Promise<void> {
  const proofRoot = path.resolve(config.LOCAL_STORAGE_PATH, "proofs");
  const directories = await fs
    .readdir(proofRoot, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const referenced = new Set(
    (await getDb().select({
      objectKey: proofAssets.objectKey,
      previewKey: proofAssets.previewKey
    }).from(proofAssets)).flatMap((asset) => [
      asset.objectKey,
      asset.previewKey
    ])
  );
  await Promise.allSettled(
    directories
      .filter((entry) => entry.isDirectory() && /^proof_[A-Za-z0-9_-]+$/.test(entry.name))
      .filter(
        (entry) =>
          !referenced.has(`proofs/${entry.name}/original.webp`) &&
          !referenced.has(`proofs/${entry.name}/preview.webp`)
      )
      .map((entry) => {
        const target = path.resolve(proofRoot, entry.name);
        const relative = path.relative(proofRoot, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return Promise.reject(new Error("Refused to clean a proof path outside private storage"));
        }
        return fs.rm(target, { recursive: true, force: true });
      })
  );
}

async function putObject(key: string, body: Buffer): Promise<void> {
  const target = getObjectPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { flag: "wx" });
}

export async function getObject(key: string): Promise<Buffer> {
  try {
    return await fs.readFile(getObjectPath(key));
  } catch {
    throw new AppError(404, "asset_not_found", "Proof image not found");
  }
}

export async function deleteObject(key: string): Promise<void> {
  await fs.rm(getObjectPath(key), { force: true });
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
