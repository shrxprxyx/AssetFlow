import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function validationError(err: ZodError) {
  const issue = err.issues[0];
  return NextResponse.json(
    { error: "validation_error", message: issue.message, field: issue.path[0] },
    { status: 400 }
  );
}

export async function readJson(
  req: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid_json", message: "Request body must be valid JSON" },
        { status: 400 }
      ),
    };
  }
}