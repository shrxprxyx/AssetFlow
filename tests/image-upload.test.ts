import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectImageType,
  fileNameFromUrl,
  fileUrl,
  isAcceptablePhotoUrl,
  mimeForFileName,
  newFileName,
  FILE_NAME_RE,
} from "@/utils/imageUpload";
import { LocalDiskStore } from "@/services/storage";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
const text = (s: string) => new TextEncoder().encode(s);

describe("detectImageType", () => {
  it("recognises JPEG, PNG and WebP from their first bytes", () => {
    expect(detectImageType(JPEG)).toBe("jpeg");
    expect(detectImageType(PNG)).toBe("png");
    expect(detectImageType(WEBP)).toBe("webp");
  });

  it("refuses everything else, whatever the file is called", () => {
    expect(detectImageType(text("<script>alert(1)</script>"))).toBeNull();
    expect(detectImageType(text("GIF89a......"))).toBeNull();
    expect(detectImageType(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectImageType(text("%PDF-1.7 ..........."))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });

  it("does not take a RIFF file that is not WebP (for example WAV)", () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectImageType(wav)).toBeNull();
  });

  it("is not fooled by a short file", () => {
    expect(detectImageType(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull();
  });
});

describe("file names and urls", () => {
  it("generates a random name with the right extension", () => {
    const a = newFileName("jpeg");
    const b = newFileName("jpeg");
    expect(a).toMatch(FILE_NAME_RE);
    expect(a.endsWith(".jpg")).toBe(true);
    expect(newFileName("png").endsWith(".png")).toBe(true);
    expect(newFileName("webp").endsWith(".webp")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("round-trips a name through its url", () => {
    const name = newFileName("png");
    expect(fileUrl(name)).toBe(`/api/files/${name}`);
    expect(fileNameFromUrl(fileUrl(name))).toBe(name);
  });

  it("rejects names that are not ones we generated", () => {
    for (const bad of [
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "photo.jpg",
      "00000000-0000-0000-0000-000000000000.svg",
      "00000000-0000-0000-0000-000000000000.jpg/../x",
      "00000000-0000-0000-0000-000000000000.jpg ",
      "",
    ]) {
      expect(mimeForFileName(bad)).toBeNull();
      expect(fileNameFromUrl(`/api/files/${bad}`)).toBeNull();
    }
  });

  it("maps the extension to a content type", () => {
    expect(mimeForFileName(newFileName("jpeg"))).toBe("image/jpeg");
    expect(mimeForFileName(newFileName("png"))).toBe("image/png");
    expect(mimeForFileName(newFileName("webp"))).toBe("image/webp");
  });
});

describe("isAcceptablePhotoUrl", () => {
  it("accepts an uploaded file and plain http(s) links", () => {
    expect(isAcceptablePhotoUrl(fileUrl(newFileName("jpeg")))).toBe(true);
    expect(isAcceptablePhotoUrl("https://example.com/laptop.jpg")).toBe(true);
    expect(isAcceptablePhotoUrl("http://example.com/laptop.jpg")).toBe(true);
  });

  it("refuses script urls, other routes, relative paths and junk", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "/api/assets",
      "/api/files/../secret",
      "laptop.jpg",
      "",
      "https://example.com/" + "a".repeat(2000),
    ]) {
      expect(isAcceptablePhotoUrl(bad)).toBe(false);
    }
  });
});

describe("LocalDiskStore", () => {
  async function withStore(fn: (store: LocalDiskStore, dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assetflow-store-"));
    try {
      await fn(new LocalDiskStore(path.join(dir, "nested")), path.join(dir, "nested"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("stores, reads back and deletes a file (creating the folder on first use)", async () => {
    await withStore(async (store) => {
      const name = newFileName("png");
      expect(await store.get(name)).toBeNull();
      await store.put(name, PNG);
      expect([...(await store.get(name))!]).toEqual([...PNG]);
      await store.delete(name);
      expect(await store.get(name)).toBeNull();
    });
  });

  it("deleting a missing file is not an error", async () => {
    await withStore(async (store) => {
      await expect(store.delete(newFileName("jpeg"))).resolves.toBeUndefined();
    });
  });

  it("refuses unsafe names for every operation", async () => {
    await withStore(async (store) => {
      await expect(store.put("../evil.jpg", JPEG)).rejects.toThrow("Unsafe file name");
      await expect(store.get("../../etc/passwd")).rejects.toThrow("Unsafe file name");
      await expect(store.delete("a/b.jpg")).rejects.toThrow("Unsafe file name");
    });
  });

  it("leaves no temporary files behind", async () => {
    await withStore(async (store, dir) => {
      const name = newFileName("webp");
      await store.put(name, WEBP);
      expect(await readdir(dir)).toEqual([name]);
    });
  });
});
