import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approveTransfer, rejectTransfer, cancelTransfer } from "@/lib/transfers";
import { requireWriteAuth } from "@/lib/guards";

const bodySchema = z.object({ action: z.enum(["approve", "reject", "cancel"]) });

// PATCH /api/transfers/:id   { "action": "approve" | "reject" | "cancel" }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWriteAuth();
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
    if (action === "approve") {
      // The event is recorded in the approval's own transaction (see lib/outbox.ts).
      await approveTransfer(user, requestId, {
        action: "transfer_approved",
        actorId: user.userId,
        resourceType: "TransferRequest",
        resourceId: requestId,
      });
    } else {
      // The event is recorded in the same transaction as the change (see lib/outbox.ts).
      const activity = {
        action: `transfer_${action === "reject" ? "rejected" : "cancelled"}`,
        actorId: user.userId,
        resourceType: "TransferRequest",
        resourceId: requestId,
      };
      if (action === "reject") await rejectTransfer(user, requestId, activity);
      else await cancelTransfer(user, requestId, activity);
    }

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
