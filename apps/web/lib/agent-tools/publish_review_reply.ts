import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  reviewId?: string;
  review_id?: string;
  responseId?: string;
  response_id?: string;
  accountName?: string;
  account_name?: string;
  locationName?: string;
  location_name?: string;
  reviewName?: string;
  review_name?: string;
  replyText?: string;
  reply_text?: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) return value;
  }
  return null;
}

export async function handlePublishReviewReply(
  _ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const input = args as Record<string, unknown>;

  const reviewId = pickString(input, "reviewId", "review_id");
  const responseId = pickString(input, "responseId", "response_id");
  const accountName = pickString(input, "accountName", "account_name");
  const locationName = pickString(input, "locationName", "location_name");
  const reviewName = pickString(input, "reviewName", "review_name");
  const replyText = pickString(input, "replyText", "reply_text");

  if (!reviewId || !responseId || !accountName || !locationName || !reviewName || !replyText) {
    return {
      ok: false,
      error: "invalid_args",
      message:
        "Missing required fields. Expected reviewId, responseId, accountName, locationName, reviewName, replyText.",
    };
  }

  return {
    ok: true,
    data: {
      published: true,
      reviewId,
      responseId,
      accountName,
      locationName,
      reviewName,
      replyText,
      publishedAt: new Date().toISOString(),
      mode: "confirm_gated_mutation",
    },
  };
}
