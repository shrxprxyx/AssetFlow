import { promises as fs } from "fs";
import path from "path";
import { FILE_NAME_RE } from "@/utils/imageUpload";

/**
 * Where uploaded files live. The rest of the app only talks to this interface,
 * and the database only stores "/api/files/<name>", so moving to S3, MinIO or
 * any other store later means writing one new class and changing getStore().
 * No data migration of URLs and no page or form changes.
 */
export interface FileStore {
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** The file's bytes, or null if there is no such file. */
  get(name: string): Promise<Buffer | null>;
  delete(name: string): Promise<void>;
}

const hasCode = (e: unknown, code: string) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;

function assertSafeName(name: string) {
  if (!FILE_NAME_RE.test(name)) throw new Error("Unsafe file name");
}

/** Files in one folder on this server's disk (a Docker volume in production). */
export class LocalDiskStore implements FileStore {
  constructor(private readonly dir: string) {}

  private pathFor(name: string) {
    assertSafeName(name);
    return path.join(this.dir, name);
  }

  async put(name: string, bytes: Uint8Array) {
    const target = this.pathFor(name);
    await fs.mkdir(this.dir, { recursive: true });
    // Write to a temp name, then rename: a reader never sees half a file.
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, target);
  }

  async get(name: string) {
    try {
      return await fs.readFile(this.pathFor(name));
    } catch (e) {
      if (hasCode(e, "ENOENT")) return null;
      throw e;
    }
  }

  async delete(name: string) {
    try {
      await fs.unlink(this.pathFor(name));
    } catch (e) {
      if (!hasCode(e, "ENOENT")) throw e;
    }
  }
}

let store: FileStore | null = null;

/** The configured store. UPLOAD_DIR sets the folder (default: ./uploads). */
export function getStore(): FileStore {
  if (!store) {
    store = new LocalDiskStore(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
  }
  return store;
}

/** Tests swap in their own store (or null to go back to the default). */
export function setStoreForTests(s: FileStore | null) {
  store = s;
}
