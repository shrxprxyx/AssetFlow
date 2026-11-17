import { randomUUID } from "crypto";

/**
 * Pure helpers for photo uploads. No database, no disk: easy to test.
 *
 * The file's TYPE is decided from its first bytes, never from the file name or
 * the Content-Type the browser sent, because both are chosen by the caller.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export type ImageType = "jpeg" | "png" | "webp";

export const EXTENSION: Record<ImageType, string> = { jpeg: "jpg", png: "png", webp: "webp" };
export const MIME: Record<ImageType, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Only names we generated ourselves are ever read from or written to disk. */
export const FILE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export const FILE_URL_PREFIX = "/api/files/";

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  // WebP: "RIFF" <4 byte size> "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export function newFileName(type: ImageType): string {
  return `${randomUUID()}.${EXTENSION[type]}`;
}

export function fileUrl(name: string): string {
  return `${FILE_URL_PREFIX}${name}`;
}

/** "/api/files/<uuid>.jpg" -> the file name, or null if it isn't one of ours. */
export function fileNameFromUrl(url: string): string | null {
  if (!url.startsWith(FILE_URL_PREFIX)) return null;
  const name = url.slice(FILE_URL_PREFIX.length);
  return FILE_NAME_RE.test(name) ? name : null;
}

export function mimeForFileName(name: string): string | null {
  if (!FILE_NAME_RE.test(name)) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return ext === "jpg" ? MIME.jpeg : ext === "png" ? MIME.png : MIME.webp;
}

/**
 * What may be saved in a photoUrl column: one of our uploaded files, or a plain
 * http(s) link (older records and pasted links). Anything else, such as
 * "javascript:..." or a path into another route, is refused.
 */
export function isAcceptablePhotoUrl(value: string): boolean {
  if (fileNameFromUrl(value)) return true;
  if (value.length > 2000) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export const PHOTO_URL_MESSAGE = "Photo must be an uploaded image or an http(s) link";
