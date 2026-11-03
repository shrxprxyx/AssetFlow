import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approveTransfer, rejectTransfer, cancelTransfer } from "@/lib/transfers";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

const bodySchema = z.object({ action: z.enum(["approve", "reject", "cancel"]) });

// PATCH /api/transfers/:id   { "action": "approve" | "reject" | "cancel" }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json({ error: "invalid_id", message: "Invalid transfer id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", message: "action must be approve, reject or cancel", field: "action" },
      { status: 400 }
    );
  }
  const { action } = parsed.data;

  try {
    if (action === "approve") await approveTransfer(user, requestId);
    else if (action === "reject") await rejectTransfer(user, requestId);
    else await cancelTransfer(user, requestId);

    await logActivity(`transfer_${action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled"}`, {
      actorId: user.userId,
      resourceType: "TransferRequest",
      resourceId: requestId,
    });

    return NextResponse.json({ success: true, action });
  } catch (e: any) {
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong updating the transfer request" },
      { status: 500 }
    );
  }
}
