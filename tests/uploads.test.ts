import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST as upload } from "@/app/api/uploads/route";
import { GET as readFile } from "@/app/api/files/[name]/route";
import { POST as createAsset } from "@/app/api/assets/route";
import { PATCH as updateAsset } from "@/app/api/assets/[id]/route";
import { POST as raiseRequest } from "@/app/api/maintenance-requests/route";
import { LocalDiskStore, setStoreForTests } from "@/services/storage";
import { MAX_UPLOAD_BYTES } from "@/utils/imageUpload";
import { LIMITS } from "@/services/rateLimit";
import { prisma } from "@/services/prisma";
import { resetDb, createUser, createAsset as makeAsset, createCategory } from "./helpers/db";
import { signInAs, signOut } from "./helpers/auth";
import { call, jsonRequest } from "./helpers/http";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function uploadRequest(bytes: Uint8Array, filename = "photo.png", type = "image/png") {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], filename, { type }));
  return new NextRequest("http://localhost/api/uploads", { method: "POST", body: form });
}

const fileParams = (name: string) => ({ params: Promise.resolve({ name }) });
const readPhoto = (name: string) =>
  readFile(new NextRequest(`http://localhost/api/files/${name}`), fileParams(name));

describe("photo uploads", () => {
  let dir: string;
  let manager: Awaited<ReturnType<typeof createUser>>;
  let employee: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assetflow-uploads-"));
    setStoreForTests(new LocalDiskStore(dir));
  });
  afterAll(async () => {
    setStoreForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDb();
    manager = await createUser({ role: "ASSET_MANAGER" });
    employee = await createUser();
    signInAs(manager);
  });

  describe("POST /api/uploads", () => {
    it("saves a photo and returns its url", async () => {
      const res = await upload(uploadRequest(PNG));
      const body = await res.json();
      expect(res.status).toBe(201);
      expect(body.url).toMatch(/^\/api\/files\/[0-9a-f-]{36}\.png$/);
      expect(body.type).toBe("image/png");
      expect(body.size).toBe(PNG.length);
    });

    it("needs a signed-in user", async () => {
      signOut();
      expect((await upload(uploadRequest(PNG))).status).toBe(401);
    });

    it("lets any signed-in role upload", async () => {
      signInAs(employee);
      expect((await upload(uploadRequest(PNG))).status).toBe(201);
    });

    it("refuses a file that is not an image, even if it is named .png and sent as image/png", async () => {
      const res = await upload(uploadRequest(new TextEncoder().encode("<script>alert(1)</script>")));
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe("unsupported_type");
    });

    it("refuses a file over the size limit", async () => {
      const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
      big.set(PNG);
      const res = await upload(uploadRequest(big));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe("file_too_large");
    });

    it("refuses an empty file and a missing file", async () => {
      expect((await upload(uploadRequest(new Uint8Array()))).status).toBe(400);
      const noFile = new NextRequest("http://localhost/api/uploads", {
        method: "POST",
        body: new FormData(),
      });
      const res = await upload(noFile);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("missing_file");
    });

    it("refuses a body that is not form data", async () => {
      const res = await upload(jsonRequest("/api/uploads", "POST", { file: "x" }));
      expect(res.status).toBe(400);
    });

    it("limits how many uploads one user can make", async () => {
      for (let i = 0; i < LIMITS.uploads.limit; i++) {
        expect((await upload(uploadRequest(PNG))).status).toBe(201);
      }
      const res = await upload(uploadRequest(PNG));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
    });
  });

  describe("GET /api/files/:name", () => {
    it("serves the stored bytes with safe headers", async () => {
      const { url } = await (await upload(uploadRequest(PNG))).json();
      const name = url.split("/").pop()!;

      const res = await readPhoto(name);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toContain("private");
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
    });

    it("needs a signed-in user", async () => {
      const { url } = await (await upload(uploadRequest(PNG))).json();
      signOut();
      expect((await readPhoto(url.split("/").pop()!)).status).toBe(401);
    });

    it("answers 404 for a file that does not exist", async () => {
      expect((await readPhoto("00000000-0000-4000-8000-000000000000.png")).status).toBe(404);
    });

    it("answers 404 for names that try to leave the folder", async () => {
      for (const bad of ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "x.png/../y"]) {
        expect((await readPhoto(bad)).status).toBe(404);
      }
    });
  });

  describe("photoUrl on assets and maintenance requests", () => {
    const assetBody = async (extra: Record<string, unknown>) => ({
      name: "Laptop",
      categoryId: (await createCategory()).id,
      ...extra,
    });

    it("an asset can be created with an uploaded photo", async () => {
      const { url } = await (await upload(uploadRequest(PNG))).json();
      const res = await call(createAsset, "POST", "/api/assets", await assetBody({ photoUrl: url }));
      expect(res.status).toBe(201);
      const saved = await prisma.asset.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(saved.photoUrl).toBe(url);
    });

    it("an older pasted https link still works", async () => {
      const res = await call(
        createAsset, "POST", "/api/assets",
        await assetBody({ photoUrl: "https://example.com/laptop.jpg" })
      );
      expect(res.status).toBe(201);
    });

    it("refuses a script url or a path into another route", async () => {
      for (const photoUrl of ["javascript:alert(1)", "/api/assets", "/api/files/../x"]) {
        const res = await call(createAsset, "POST", "/api/assets", await assetBody({ photoUrl }));
        expect(res.status).toBe(400);
        expect(res.body.field).toBe("photoUrl");
      }
    });

    it("editing an asset can set a photo and clear it again", async () => {
      const asset = await makeAsset();
      const { url } = await (await upload(uploadRequest(PNG))).json();
      const patch = (body: unknown) =>
        updateAsset(jsonRequest(`/api/assets/${asset.id}`, "PATCH", body), {
          params: Promise.resolve({ id: String(asset.id) }),
        });

      expect((await patch({ photoUrl: url })).status).toBe(200);
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).photoUrl).toBe(url);

      expect((await patch({ photoUrl: "" })).status).toBe(200);
      expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).photoUrl).toBeNull();

      expect((await patch({ photoUrl: "javascript:alert(1)" })).status).toBe(400);
    });

    it("a maintenance request can carry a photo of the problem", async () => {
      const asset = await makeAsset();
      signInAs(employee);
      const { url } = await (await upload(uploadRequest(PNG))).json();

      const res = await call(raiseRequest, "POST", "/api/maintenance-requests", {
        assetId: asset.id,
        description: "Screen is cracked",
        photoUrl: url,
      });
      expect(res.status).toBe(201);
      expect(res.body.request.photoUrl).toBe(url);
    });

    it("a maintenance request without a photo (or with an empty one) still works", async () => {
      const asset = await makeAsset();
      signInAs(employee);
      for (const extra of [{}, { photoUrl: "" }]) {
        const res = await call(raiseRequest, "POST", "/api/maintenance-requests", {
          assetId: asset.id,
          description: "Screen is cracked",
          ...extra,
        });
        expect(res.status).toBe(201);
        expect(res.body.request.photoUrl).toBeNull();
      }
    });

    it("a maintenance request refuses a bad photo url", async () => {
      const asset = await makeAsset();
      signInAs(employee);
      const res = await call(raiseRequest, "POST", "/api/maintenance-requests", {
        assetId: asset.id,
        description: "Screen is cracked",
        photoUrl: "javascript:alert(1)",
      });
      expect(res.status).toBe(400);
    });
  });
});
