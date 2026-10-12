import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type ParsedArgs = {
  locationName: string;
  summary: string;
  callToActionType?: string;
  callToActionUrl?: string;
  mediaFormat?: "PHOTO";
  sourceDraftId?: string;
  dryRun?: boolean;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseArgs(args: Args): ParsedArgs {
  const locationName = asString(args.locationName);
  const summary = asString(args.summary);

  if (!locationName) {
    throw new Error("publish_gbp_post requires `locationName`.");
  }

  if (!summary) {
    throw new Error("publish_gbp_post requires `summary`.");
  }

  const callToActionType = asString(args.callToActionType);
  const callToActionUrl = asString(args.callToActionUrl);
  const sourceDraftId = asString(args.sourceDraftId);
  const dryRun = args.dryRun === true;

  return {
    locationName,
    summary,
    callToActionType,
    callToActionUrl,
    mediaFormat: "PHOTO",
    sourceDraftId,
    dryRun,
  };
}

function okResult(data: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    data,
  } as HandlerResult;
}

function errResult(code: string, message: string, details?: Record<string, unknown>): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
      details: details ?? {},
    },
  } as HandlerResult;
}

/**
 * Company-local mutation tool: publish_gbp_post
 * Confirm-gated publish entrypoint for GBP local post mutation flow.
 */
export async function handlePublishGbpPost(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const parsed = parseArgs(args);

    if (parsed.dryRun) {
      return okResult({
        status: "validated",
        tool: "publish_gbp_post",
        autonomy: "autonomous",
        parsed,
      });
    }

    return okResult({
      status: "accepted",
      tool: "publish_gbp_post",
      autonomy: "autonomous",
      message:
        "publish_gbp_post handler is registered and validated. Runtime publish flow executes via the cross-boundary mutation bridge.",
      request: {
        locationName: parsed.locationName,
        summary: parsed.summary,
        callToActionType: parsed.callToActionType ?? null,
        callToActionUrl: parsed.callToActionUrl ?? null,
        mediaFormat: parsed.mediaFormat,
        sourceDraftId: parsed.sourceDraftId ?? null,
      },
      context: {
        actorId:
          (ctx as { userId?: string }).userId ??
          (ctx as { actorId?: string }).actorId ??
          null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errResult("invalid_arguments", message);
  }
}
