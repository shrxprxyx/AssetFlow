import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/guards";
import { getStore } from "@/lib/storage";
import { mimeForFileName } from "@/lib/imageUpload";

export const runtime = "nodejs";

// GET /api/files/<uuid>.jpg  -> the photo. Signed-in users only.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;

  const { name } = await params;
  // Rejects anything that isn't a name we generated, so "../" tricks never reach the disk.
  const mime = mimeForFileName(name);
  if (!mime) {
    return NextResponse.json({ error: "not_found", message: "File not found" }, { status: 404 });
  }

  const bytes = await getStore().get(name);
  if (!bytes) {
    return NextResponse.json({ error: "not_found", message: "File not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // The name is random and the content never changes, so the browser may keep it.
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
