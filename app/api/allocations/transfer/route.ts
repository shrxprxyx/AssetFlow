import { NextRequest, NextResponse } from "next/server";
import { TransferAssetSchema } from "@/lib/schemas";
import { createTransferRequest } from "@/lib/transfers";
import { logActivity } from "@/lib/logActivity";
import { requireAuth } from "@/lib/guards";

// Creates a transfer REQUEST. The asset doesn't move until it's approved
// (managers' own requests are approved immediately; see lib/transfers.ts).
export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (!guard.ok) return guard.response;
  const { user } = guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  const parsed = TransferAssetSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: "validation_error", message: issue.message, field: issue.path[0] },
      { status: 400 }
    );
  }
  const { assetId, toHolderId, reason } = parsed.data;

  try {
    const result = await createTransferRequest(user, { assetId, toHolderId, reason });

    await logActivity(result.autoApproved ? "transfer_completed" : "transfer_requested", {
      actorId: user.userId,
      resourceType: "TransferRequest",
      resourceId: result.request.id,
      changes: { assetId, toHolderId },
    });

    return NextResponse.json(
      {
        request: result.request,
        autoApproved: result.autoApproved,
        message: result.autoApproved
          ? "Asset transferred successfully."
          : "Transfer request submitted. The asset moves once a manager approves it.",
      },
      { status: 201 }
    );
  } catch (e: any) {
    if (e?.status && e?.body) return NextResponse.json(e.body, { status: e.status });
    console.error(e);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong creating the transfer request" },
      { status: 500 }
    );
  }
}
