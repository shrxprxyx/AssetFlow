import { NextRequest, NextResponse } from "next/server";
import { requireWriteAuth } from "@/services/guards";
import { LIMITS, rateLimit, tooManyRequests } from "@/services/rateLimit";
import { getStore } from "@/services/storage";
import {
  MAX_UPLOAD_BYTES,
  MIME,
  detectImageType,
  fileUrl,
  newFileName,
} from "@/utils/imageUpload";

export const runtime = "nodejs";

const err = (status: number, error: string, message: string) =>
  NextResponse.json({ error, message }, { status });

// POST /api/uploads   multipart/form-data, field "file"  ->  201 { url }
// The returned url is then saved in an asset's or maintenance request's photoUrl.
export async function POST(req: NextRequest) {
  const guard = await requireWriteAuth();
  if (!guard.ok) return guard.response;

  const limited = await rateLimit(LIMITS.uploads, String(guard.user.userId));
  if (!limited.allowed) return tooManyRequests(limited, "Too many uploads. Please try again later.");

  // Refuse an obviously oversized body before reading it. The header can be
  // wrong, so the real size is checked again below.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return err(413, "file_too_large", "Photos can be at most 5 MB");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, "invalid_form", "Send the photo as multipart form data in a field named 'file'");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return err(400, "missing_file", "Choose a photo to upload");
  }
  if (file.size === 0) return err(400, "empty_file", "That file is empty");
  if (file.size > MAX_UPLOAD_BYTES) return err(413, "file_too_large", "Photos can be at most 5 MB");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes);
  if (!type) {
    return err(415, "unsupported_type", "Only JPEG, PNG or WebP photos can be uploaded");
  }

  const name = newFileName(type);
  try {
    await getStore().put(name, bytes);
  } catch (e) {
    console.error(e);
    return err(500, "server_error", "Could not save the photo");
  }

  return NextResponse.json(
    { url: fileUrl(name), size: bytes.length, type: MIME[type] },
    { status: 201 }
  );
}
