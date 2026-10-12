import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  reviewId?: unknown;
  locationId?: unknown;
  orgId?: unknown;
  draftReply?: unknown;
  flagReasons?: unknown;
  needsOwnerApproval?: unknown;
  notifyOwnerAt?: unknown;
};

type JsonObject = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function asIsoOrNow(value: unknown): string {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString();
  }
  return d.toISOString();
}

function parseArgs(raw: Args): {
  reviewId: string;
  locationId: string;
  orgId: string;
  draftReply: string;
  flagReasons: string[];
  notifyOwnerAt: string;
} {
  const reviewId = asString(raw.reviewId);
  const locationId = asString(raw.locationId);
  const orgId = asString(raw.orgId);
  const draftReply = asString(raw.draftReply);

  if (!reviewId || !locationId || !orgId || !draftReply) {
    throw new Error("missing_required_fields");
  }

  return {
    reviewId,
    locationId,
    orgId,
    draftReply,
    flagReasons: asStringArray(raw.flagReasons),
    notifyOwnerAt: asIsoOrNow(raw.notifyOwnerAt),
  };
}

export async function handleQueueReplyForOwnerApproval(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const parsed = parseArgs(args);
    const payload: JsonObject = {
      tool: "queue_reply_for_owner_approval",
      autonomy: "human_review",
      reviewId: parsed.reviewId,
      locationId: parsed.locationId,
      orgId: parsed.orgId,
      status: "pending_owner",
      draftReply: parsed.draftReply,
      flagReasons: parsed.flagReasons,
      notifyOwnerAt: parsed.notifyOwnerAt,
      queuedAt: new Date().toISOString(),
    };

    return {
      ok: true,
      data: payload,
    } as HandlerResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message,
      },
    } as HandlerResult;
  }
}
