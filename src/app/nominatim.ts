// Nominatim (OpenStreetMap) geocoding: turning "Södermalm" into a position, so
// the manual location fallback does not require panning the whole planet.
//
// Pure data — no Leaflet, no DOM — and `fetch` is injectable, so this stays
// testable offline.
//
// ── Nominatim's usage policy, and how this file honours it ──
//
//   1. "Provide identification." A browser cannot set User-Agent, but it always
//      sends a Referer, and the policy accepts either. Ours identifies the
//      deployed app by origin. Nothing else here is allowed to strip it.
//   2. "No more than one request per second." Enforced by {@link createRateGate}
//      below, not by hope: callers queue behind a shared gate.
//   3. "No autocomplete / no per-keystroke queries." Enforced by the caller —
//      the search box only fires on an explicit submit (see place-search.ts).
//
// The results are translated into the app's own {@link PlaceMatch}/`LatLon`
// types here, so no Nominatim-shaped object escapes this module.

import type { LatLon } from "./types";

/** A place name the user can pick to say "search from here". */
export interface PlaceMatch {
  /** Nominatim's human-readable label, e.g. "Södermalm, Stockholm, Sverige". */
  label: string;
  position: LatLon;
}

const SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** Enough choices to disambiguate "Paris", few enough to tap through. */
const RESULT_LIMIT = 5;

/** Nominatim's published ceiling: one request per second, absolute. */
export const MIN_REQUEST_INTERVAL_MS = 1000;

/** Raw shape of one Nominatim hit — coordinates arrive as strings. */
interface RawNominatimResult {
  display_name?: string;
  lat?: string;
  lon?: string;
}

/**
 * A gate that lets at most one caller through per `minIntervalMs`.
 *
 * Callers queue rather than fail: a second search a moment after the first
 * still happens, just late. Each caller reserves its slot synchronously before
 * awaiting, so ten simultaneous callers are spaced a second apart instead of
 * all deciding at once that the coast is clear.
 *
 * `now` and `sleep` are parameters so the timing can be tested without waiting
 * in real seconds.
 */
export function createRateGate(
  minIntervalMs: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  let nextAllowedAt = 0;

  return async () => {
    const goAt = Math.max(now(), nextAllowedAt);
    nextAllowedAt = goAt + minIntervalMs;
    const wait = goAt - now();
    if (wait > 0) {
      await sleep(wait);
    }
  };
}

/**
 * The one gate every Nominatim request in this app shares. Module-level on
 * purpose: a per-caller limiter would let two callers double the rate.
 */
const nominatimGate = createRateGate(MIN_REQUEST_INTERVAL_MS);

export interface SearchPlacesOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** Waits until the fair-use rate limit allows another request. */
  gate?: () => Promise<void>;
}

/**
 * Parse one coordinate string. Blank and missing values become NaN rather than
 * `Number("")`'s cheerful 0 — that would land the result on Null Island, which
 * is precisely the confidently-wrong answer this app refuses to give.
 */
function toCoordinate(value: string | undefined): number {
  return value === undefined || value.trim() === ""
    ? Number.NaN
    : Number(value);
}

/** Build the search request URL with the query safely encoded. */
export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: String(RESULT_LIMIT),
    q: query,
  });
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/**
 * Look up a free-text place name. Resolves with up to {@link RESULT_LIMIT}
 * matches, and rejects on HTTP or network failure so the UI can say so out
 * loud. Hits missing a name or a usable position are dropped rather than shown
 * as broken rows — a list entry nobody can act on is worse than a shorter list.
 */
export async function searchPlaces(
  query: string,
  { fetchFn = fetch, signal, gate = nominatimGate }: SearchPlacesOptions = {},
): Promise<PlaceMatch[]> {
  await gate();

  const response = await fetchFn(buildSearchUrl(query), { signal });
  if (!response.ok) {
    throw new Error(`Nominatim search failed with status ${response.status}`);
  }

  const raw = (await response.json()) as RawNominatimResult[];
  return raw
    .map((hit) => ({
      label: hit.display_name ?? "",
      position: { lat: toCoordinate(hit.lat), lon: toCoordinate(hit.lon) },
    }))
    .filter(
      (match) =>
        match.label !== "" &&
        Number.isFinite(match.position.lat) &&
        Number.isFinite(match.position.lon),
    );
}
