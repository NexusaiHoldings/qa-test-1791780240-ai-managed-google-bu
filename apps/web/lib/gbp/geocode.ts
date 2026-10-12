/**
 * Service-area city geocoding (F1-004 Voice Profile Builder).
 *
 * The onboarding questionnaire collects the cities an owner serves; those cities
 * must be geocoded to lat/lng so the weekly rank snapshot can query the local
 * map-pack position at a fixed point (the GBP API exposes impressions but not
 * position — customer_evidence: "A move from position 3-4 to 8-9 is real").
 *
 * Primary provider is the Google Geocoding API (GOOGLE_MAPS_API_KEY /
 * GEOCODING_API_KEY). When no key is configured (preview builds, local dev) we
 * fall back to a small built-in gazetteer of common US metros, and finally to a
 * deterministic null-coordinate record that still preserves the typed city so
 * the questionnaire never blocks on a geocoder outage. No secrets are hardcoded;
 * every key is read from process.env at call time.
 */

export type GeocodeSource = "google" | "builtin" | "unresolved";

export interface GeocodedCity {
  /** The raw city string the owner typed (normalized/trimmed). */
  city: string;
  /** Resolved latitude, or null when the city could not be geocoded. */
  lat: number | null;
  /** Resolved longitude, or null when the city could not be geocoded. */
  lng: number | null;
  /** Provider-formatted address, when available. */
  formattedAddress: string | null;
  /** Which provider resolved the coordinates. */
  source: GeocodeSource;
}

interface GazetteerEntry {
  lat: number;
  lng: number;
  formattedAddress: string;
}

/**
 * Small offline gazetteer so previews and tests resolve common metros without a
 * network call or API key. Keyed by a normalized lower-case city token.
 */
const BUILTIN_GAZETTEER: Readonly<Record<string, GazetteerEntry>> = {
  phoenix: { lat: 33.4484, lng: -112.074, formattedAddress: "Phoenix, AZ, USA" },
  mesa: { lat: 33.4152, lng: -111.8315, formattedAddress: "Mesa, AZ, USA" },
  scottsdale: { lat: 33.4942, lng: -111.9261, formattedAddress: "Scottsdale, AZ, USA" },
  tempe: { lat: 33.4255, lng: -111.94, formattedAddress: "Tempe, AZ, USA" },
  chandler: { lat: 33.3062, lng: -111.8413, formattedAddress: "Chandler, AZ, USA" },
  gilbert: { lat: 33.3528, lng: -111.789, formattedAddress: "Gilbert, AZ, USA" },
  glendale: { lat: 33.5387, lng: -112.186, formattedAddress: "Glendale, AZ, USA" },
  tucson: { lat: 32.2226, lng: -110.9747, formattedAddress: "Tucson, AZ, USA" },
  dallas: { lat: 32.7767, lng: -96.797, formattedAddress: "Dallas, TX, USA" },
  houston: { lat: 29.7604, lng: -95.3698, formattedAddress: "Houston, TX, USA" },
  austin: { lat: 30.2672, lng: -97.7431, formattedAddress: "Austin, TX, USA" },
  denver: { lat: 39.7392, lng: -104.9903, formattedAddress: "Denver, CO, USA" },
  atlanta: { lat: 33.749, lng: -84.388, formattedAddress: "Atlanta, GA, USA" },
  orlando: { lat: 28.5383, lng: -81.3792, formattedAddress: "Orlando, FL, USA" },
  tampa: { lat: 27.9506, lng: -82.4572, formattedAddress: "Tampa, FL, USA" },
  charlotte: { lat: 35.2271, lng: -80.8431, formattedAddress: "Charlotte, NC, USA" },
  nashville: { lat: 36.1627, lng: -86.7816, formattedAddress: "Nashville, TN, USA" },
  "las vegas": { lat: 36.1699, lng: -115.1398, formattedAddress: "Las Vegas, NV, USA" },
  sacramento: { lat: 38.5816, lng: -121.4944, formattedAddress: "Sacramento, CA, USA" },
  portland: { lat: 45.5152, lng: -122.6784, formattedAddress: "Portland, OR, USA" },
};

/** Normalize a free-typed city for display (collapse whitespace, trim). */
export function normalizeCity(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** The lookup key used against the built-in gazetteer. */
function gazetteerKey(city: string): string {
  // Only the leading city token matters for a fuzzy builtin match, e.g.
  // "Phoenix, AZ" → "phoenix".
  return normalizeCity(city).toLowerCase().split(",")[0].trim();
}

function readApiKey(): string | null {
  const key = process.env.GOOGLE_MAPS_API_KEY ?? process.env.GEOCODING_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

interface GoogleGeocodeResponse {
  status?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
}

/**
 * Geocode one city via the Google Geocoding API. Returns null on any failure
 * (no key, network error, zero results) so callers can fall through to the
 * built-in gazetteer. Timed out at 8s to keep the questionnaire responsive.
 */
async function geocodeViaGoogle(city: string): Promise<GeocodedCity | null> {
  const apiKey = readApiKey();
  if (!apiKey) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", city);
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as GoogleGeocodeResponse;
    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return null;
    }
    const top = data.results[0];
    const loc = top.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return null;
    }
    return {
      city: normalizeCity(city),
      lat: loc.lat,
      lng: loc.lng,
      formattedAddress: top.formatted_address ?? null,
      source: "google",
    };
  } catch {
    // Any geocoder error is non-fatal — fall back to the gazetteer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a city from the offline gazetteer, or null when unknown. */
function geocodeViaBuiltin(city: string): GeocodedCity | null {
  const entry = BUILTIN_GAZETTEER[gazetteerKey(city)];
  if (!entry) return null;
  return {
    city: normalizeCity(city),
    lat: entry.lat,
    lng: entry.lng,
    formattedAddress: entry.formattedAddress,
    source: "builtin",
  };
}

/**
 * Geocode a single city, trying Google first, then the built-in gazetteer, then
 * returning an unresolved record that still carries the typed city name.
 */
export async function geocodeCity(rawCity: string): Promise<GeocodedCity> {
  const city = normalizeCity(rawCity);
  if (!city) {
    return { city: "", lat: null, lng: null, formattedAddress: null, source: "unresolved" };
  }

  const viaGoogle = await geocodeViaGoogle(city);
  if (viaGoogle) return viaGoogle;

  const viaBuiltin = geocodeViaBuiltin(city);
  if (viaBuiltin) return viaBuiltin;

  return {
    city,
    lat: null,
    lng: null,
    formattedAddress: null,
    source: "unresolved",
  };
}

/**
 * Geocode a list of service-area cities. De-duplicates case-insensitively,
 * caps at `limit` (default 25) to bound external quota, and preserves input
 * order. Runs lookups sequentially to stay well under the geocoder's QPS.
 */
export async function geocodeCities(
  rawCities: readonly string[],
  limit = 25,
): Promise<GeocodedCity[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of rawCities) {
    const city = normalizeCity(raw);
    if (!city) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(city);
    if (unique.length >= limit) break;
  }

  const out: GeocodedCity[] = [];
  for (const city of unique) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await geocodeCity(city));
  }
  return out;
}
