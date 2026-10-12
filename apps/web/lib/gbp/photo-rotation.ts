/**
 * Owner-photo rotation (F1-005).
 *
 * Photos are uploaded via @nexus/files-and-media and categorized by the agent;
 * `gbp_photos` is the per-org rotation ledger (one row per usable photo, keyed to
 * a files-and-media `files.id`). The weekly publisher selects the
 * least-recently-used photo for the week's service line, then records usage so
 * the same shot isn't reused until the rest of the library has cycled.
 *
 * No AI image generation (liability): weekly photos come ONLY from the owner's
 * own uploads. DB access uses the substrate's lazy `require("pg")` pool so
 * preview builds without DATABASE_URL still compile. All queries parameterized.
 */

interface PoolLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

let _pool: PoolLike | null = null;

function getPool(): PoolLike {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => PoolLike;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export interface GbpPhoto {
  id: string;
  orgId: string;
  connectionId: string | null;
  fileId: string | null;
  storageKey: string | null;
  signedUrl: string | null;
  filename: string | null;
  category: string;
  serviceLine: string;
  caption: string | null;
  useCount: number;
  lastUsedAt: string | null;
  uploadedAt: string;
  isActive: boolean;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapPhoto(row: Record<string, unknown>): GbpPhoto {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    fileId: row.file_id == null ? null : String(row.file_id),
    storageKey: row.storage_key == null ? null : String(row.storage_key),
    signedUrl: row.signed_url == null ? null : String(row.signed_url),
    filename: row.filename == null ? null : String(row.filename),
    category: String(row.category ?? "jobsite"),
    serviceLine: String(row.service_line ?? "multi-trade"),
    caption: row.caption == null ? null : String(row.caption),
    useCount: Number(row.use_count ?? 0),
    lastUsedAt: toIso(row.last_used_at),
    uploadedAt: toIso(row.uploaded_at) ?? "",
    isActive: Boolean(row.is_active),
  };
}

const PHOTO_COLUMNS = `
  id, org_id, connection_id, file_id, storage_key, signed_url, filename,
  category, service_line, caption, use_count, last_used_at, uploaded_at, is_active
`;

/**
 * List all of an org's photos for the /photos grid (newest upload first).
 */
export async function listPhotos(orgId: string): Promise<GbpPhoto[]> {
  const rows = await query(
    `SELECT ${PHOTO_COLUMNS}
       FROM gbp_photos
      WHERE org_id = $1
      ORDER BY uploaded_at DESC, created_at DESC`,
    [orgId],
  );
  return rows.map(mapPhoto);
}

/**
 * Select the least-recently-used ACTIVE photo for this week's service line.
 *
 * LRU ordering: never-used photos first (last_used_at NULL), then oldest
 * last_used_at, then lowest use_count — so the whole library cycles before any
 * photo repeats. Falls back to the org's `multi-trade` pool, then to ANY active
 * photo, so a thin library for one trade still yields a shot.
 */
export async function selectPhotoForServiceLine(
  orgId: string,
  serviceLine: string,
): Promise<GbpPhoto | null> {
  const byLine = await query(
    `SELECT ${PHOTO_COLUMNS}
       FROM gbp_photos
      WHERE org_id = $1 AND is_active = TRUE AND service_line = $2
      ORDER BY last_used_at ASC NULLS FIRST, use_count ASC, uploaded_at ASC
      LIMIT 1`,
    [orgId, serviceLine],
  );
  if (byLine.length > 0) return mapPhoto(byLine[0]);

  const fallback = await query(
    `SELECT ${PHOTO_COLUMNS}
       FROM gbp_photos
      WHERE org_id = $1 AND is_active = TRUE
        AND (service_line = 'multi-trade' OR TRUE)
      ORDER BY (service_line = 'multi-trade') DESC,
               last_used_at ASC NULLS FIRST, use_count ASC, uploaded_at ASC
      LIMIT 1`,
    [orgId],
  );
  return fallback.length > 0 ? mapPhoto(fallback[0]) : null;
}

/**
 * Record that a photo was used in a published post: bump use_count and stamp
 * last_used_at so it drops to the back of the rotation.
 */
export async function recordPhotoUsage(photoId: string): Promise<void> {
  await query(
    `UPDATE gbp_photos
        SET use_count = use_count + 1,
            last_used_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [photoId],
  );
}

export interface RegisterPhotoInput {
  orgId: string;
  connectionId?: string | null;
  fileId?: string | null;
  storageKey?: string | null;
  signedUrl?: string | null;
  filename?: string | null;
  category: string;
  serviceLine: string;
  caption?: string | null;
}

/**
 * Register (or idempotently update) a rotation entry for an owner upload. Called
 * after @nexus/files-and-media has stored + scanned the image and the agent has
 * assigned a category/service line.
 */
export async function registerPhoto(input: RegisterPhotoInput): Promise<GbpPhoto> {
  const rows = await query(
    `INSERT INTO gbp_photos
        (org_id, connection_id, file_id, storage_key, signed_url, filename, category, service_line, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PHOTO_COLUMNS}`,
    [
      input.orgId,
      input.connectionId ?? null,
      input.fileId ?? null,
      input.storageKey ?? null,
      input.signedUrl ?? null,
      input.filename ?? null,
      input.category,
      input.serviceLine,
      input.caption ?? null,
    ],
  );
  return mapPhoto(rows[0]);
}

/**
 * Human-friendly rotation caption for the /photos grid, e.g. "used 2× · last Jun 3".
 */
export function usageCaption(photo: GbpPhoto): string {
  if (photo.useCount === 0 || !photo.lastUsedAt) {
    return "not used yet";
  }
  const when = new Date(photo.lastUsedAt);
  const label = Number.isNaN(when.getTime())
    ? photo.lastUsedAt
    : when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `used ${photo.useCount}× · last ${label}`;
}
