import type { JSX } from "react";
import Link from "next/link";
import { resolveGbpContext } from "@/lib/gbp/access";
import { listPhotos, usageCaption, type GbpPhoto } from "@/lib/gbp/photo-rotation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATEGORY_LABELS: Record<string, string> = {
  team: "Team",
  jobsite: "Job site",
  "before-after": "Before / after",
  equipment: "Equipment",
  "finished-work": "Finished work",
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

function Chip({ text }: { text: string }): JSX.Element {
  return (
    <span
      className="muted"
      style={{
        display: "inline-block",
        padding: "0.1rem 0.55rem",
        borderRadius: "999px",
        border: "1px solid var(--border, #d1d5db)",
        fontSize: "0.75rem",
        fontWeight: 600,
      }}
    >
      {text}
    </span>
  );
}

function PhotoTile({ photo }: { photo: GbpPhoto }): JSX.Element {
  return (
    <figure
      className="card"
      style={{
        breakInside: "avoid",
        margin: "0 0 1rem 0",
        padding: "0.5rem",
      }}
    >
      {photo.signedUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo.signedUrl}
          alt={photo.caption ?? photo.filename ?? "Owner photo"}
          style={{ width: "100%", borderRadius: "6px", display: "block" }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            width: "100%",
            aspectRatio: "4 / 3",
            borderRadius: "6px",
            background: "rgba(0,0,0,0.06)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "2rem",
          }}
        >
          🖼️
        </div>
      )}
      <figcaption style={{ marginTop: "0.5rem" }}>
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "0.35rem" }}>
          <Chip text={categoryLabel(photo.category)} />
          <Chip text={photo.serviceLine} />
        </div>
        {photo.caption ? <p style={{ margin: "0 0 0.25rem 0" }}>{photo.caption}</p> : null}
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
          {usageCaption(photo)}
        </p>
      </figcaption>
    </figure>
  );
}

export default async function PhotosPage(): Promise<JSX.Element> {
  const ctx = await resolveGbpContext();
  if (!ctx) {
    return (
      <main>
        <h1>Your photos</h1>
        <p className="muted">
          Please <a href="/login">log in</a> to manage the photos we post.
        </p>
      </main>
    );
  }

  const photos = await listPhotos(ctx.orgId);

  return (
    <main>
      <h1>Your photos</h1>
      <p>
        These are the photos we rotate through your weekly posts. We always use
        your own uploads — never stock or AI images. Upload more and we&rsquo;ll
        keep every post looking fresh.
      </p>

      <p>
        <Link className="btn" href="/files">
          Upload a photo
        </Link>
      </p>

      {photos.length === 0 ? (
        <div className="empty">
          <p aria-hidden="true" style={{ fontSize: "2.5rem" }}>
            📷
          </p>
          <h2>No photos yet</h2>
          <p className="muted">
            Add a few shots of recent jobs, your team or your truck. Clear,
            well-lit photos make the biggest difference — we&rsquo;ll handle the
            rest and spread them across your weekly posts.
          </p>
          <Link className="btn" href="/files">
            Upload your first photo
          </Link>
        </div>
      ) : (
        <section
          aria-label="Photo library"
          style={{
            columnCount: 3,
            columnGap: "1rem",
          }}
        >
          {photos.map((photo) => (
            <PhotoTile key={photo.id} photo={photo} />
          ))}
        </section>
      )}
    </main>
  );
}
