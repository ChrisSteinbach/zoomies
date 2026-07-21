import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot, LatLon, SpotTags } from "./types";

/**
 * The MVP's data source: the public Overpass API (docs/spec.md §5, Option A).
 *
 * Every Overpass-shaped idea — the query language, `elements`, node/way/
 * relation, the `tags` bag, HTTP status codes — is confined to this file.
 * What leaves it is {@link DogSpot} and {@link PlaceProviderError}, so the
 * phase-4 offline provider can take its place without the UI noticing.
 */

/** The main public instance. Free, shared, and fair-use limited (spec §5). */
export const DEFAULT_OVERPASS_ENDPOINT =
  "https://overpass-api.de/api/interpreter";

/** A public mirror, for when the main instance has no slots (spec §5). */
export const OVERPASS_MIRROR_ENDPOINT =
  "https://overpass.kumi.systems/api/interpreter";

/** The server-side budget, declared inside the query itself. */
const OVERPASS_SERVER_TIMEOUT_S = 25;

/**
 * How long the client waits before giving up.
 *
 * Overpass promises to abandon the query after {@link
 * OVERPASS_SERVER_TIMEOUT_S}; the margin covers connection setup and transfer
 * of the answer. Without a deadline of our own, a stalled connection leaves
 * the UI spinning forever — the browser's default is minutes.
 */
export const OVERPASS_CLIENT_TIMEOUT_MS =
  (OVERPASS_SERVER_TIMEOUT_S + 5) * 1_000;

export interface OverpassOptions {
  /** Which instance to query. Defaults to {@link DEFAULT_OVERPASS_ENDPOINT}. */
  endpoint?: string;
  /**
   * The `fetch` to use.
   *
   * Injected rather than reached for globally so tests can drive every
   * response shape — including the malformed ones that matter most — without
   * a network and without patching globals out from under other tests.
   */
  fetchImpl?: typeof fetch;
}

/**
 * A {@link PlaceProvider} backed by a live Overpass instance.
 *
 * One call is one query. Radius expansion, caching and concurrency limits are
 * deliberately not here: they are policy about *when* to ask, and they compose
 * on top of a provider that does exactly one thing.
 */
export function createOverpassProvider(
  options: OverpassOptions = {},
): PlaceProvider {
  const endpoint = options.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;
  // Wrapped rather than aliased: an unbound `globalThis.fetch` throws
  // "Illegal invocation" when called in a browser.
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async findDogParks(lat, lon, radiusM) {
      const query = buildDogParkQuery(lat, lon, radiusM);
      const payload = await postQuery(fetchImpl, endpoint, query);
      return toDogSpots(payload);
    },
  };
}

/**
 * The dog-park query of docs/spec.md §5.
 *
 * `nwr` because a dog park may be mapped as a node, a way or a relation
 * (§4.5.4), and `out center;` because we need one point per feature rather
 * than the full geometry of an area.
 */
function buildDogParkQuery(lat: number, lon: number, radiusM: number): string {
  return [
    `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`,
    `nwr["leisure"="dog_park"](around:${Math.round(radiusM)},${formatCoord(lat)},${formatCoord(lon)});`,
    "out center;",
  ].join("\n");
}

/**
 * A coordinate as Overpass wants it: plain decimal.
 *
 * Fixed notation because `String(5e-7)` is `"5e-7"`, which Overpass rejects
 * as a syntax error. Seven decimals is OSM's own precision (about a
 * centimetre) — far finer than a phone's GPS fix.
 */
function formatCoord(value: number): string {
  return value.toFixed(7);
}

/** Sends the query and returns the parsed JSON body, or throws. */
async function postQuery(
  fetchImpl: typeof fetch,
  endpoint: string,
  query: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OVERPASS_CLIENT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // URLSearchParams escapes the query. Hand-concatenating `data=` + the
      // query would corrupt it: the query is full of `[`, `]`, `"` and `=`.
      //
      // Note we cannot set a User-Agent here — browsers forbid it, and
      // overpass-api.de answers a blank one with an HTML 406 page. That page
      // is one reason `malformed-response` exists.
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });

    if (!response.ok) throw errorForStatus(response);
    return await readJson(response);
  } catch (cause) {
    // Already diagnosed above; do not re-wrap it as a transport failure.
    if (cause instanceof PlaceProviderError) throw cause;
    if (timedOut || isAbortError(cause)) {
      throw new PlaceProviderError(
        "timeout",
        `Overpass did not answer within ${OVERPASS_CLIENT_TIMEOUT_MS}ms`,
        { cause },
      );
    }
    // fetch rejects only when the request never reached a server: offline,
    // DNS failure, or a CORS rejection.
    throw new PlaceProviderError(
      "network-unavailable",
      `Could not reach Overpass at ${endpoint}`,
      { cause },
    );
  } finally {
    clearTimeout(deadline);
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** Maps a non-2xx response onto the failure the UI should react to. */
function errorForStatus(response: Response): PlaceProviderError {
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  const status = response.status;

  // 429 is the explicit rate limit: we asked too often.
  if (status === 429) {
    return new PlaceProviderError(
      "rate-limited",
      "Overpass is rate-limiting us",
      {
        status,
        retryAfterMs,
      },
    );
  }

  // 504 from Overpass is not a broken gateway — it is how the dispatcher says
  // every query slot is taken. Both mean "not now", but only one of them is
  // about us, and the UI says different things about them.
  if (status === 504) {
    return new PlaceProviderError("busy", "Overpass has no free slot", {
      status,
      retryAfterMs,
    });
  }

  return new PlaceProviderError(
    "http-error",
    `Overpass answered ${status} ${response.statusText}`.trimEnd(),
    { status, retryAfterMs },
  );
}

/**
 * `Retry-After` in milliseconds.
 *
 * RFC 9110 allows either a delay in seconds or an HTTP-date; Overpass sends
 * seconds, but proxies in front of it may not. An unparseable value is
 * treated as absent — a missing hint is survivable, a wrong one is not.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;

  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  // A date already in the past means "retry now", not "retry in the past".
  return Math.max(0, at - Date.now());
}

/** The body of a 2xx response, as JSON, or a `malformed-response` failure. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    // Overpass serves HTML error pages with a 200 in some configurations,
    // and behind a captive portal anything can come back.
    throw new PlaceProviderError(
      "malformed-response",
      "Overpass returned a body that is not JSON",
      { cause },
    );
  }

  // A `remark` means the query did not run to completion, so the elements
  // present are an unknown subset of the real answer. Reporting a partial
  // result as the whole truth is exactly the confidently-wrong answer the
  // spec forbids (§3) — fail instead, and let the caller retry.
  const remark = isRecord(parsed) ? parsed.remark : undefined;
  if (typeof remark === "string" && remark !== "") throw errorForRemark(remark);

  return parsed;
}

function errorForRemark(remark: string): PlaceProviderError {
  // e.g. `runtime error: Query timed out in "recurse" at line 3 after 25
  // seconds` — the server hit its own [timeout:25]. That is a timeout by any
  // other name, and retryable, whereas a malformed body is not.
  if (/timed out/i.test(remark)) {
    return new PlaceProviderError("timeout", `Overpass gave up: ${remark}`);
  }
  return new PlaceProviderError(
    "malformed-response",
    `Overpass returned an incomplete result: ${remark}`,
  );
}

/**
 * The Overpass payload as dog spots.
 *
 * Elements we cannot place on a map are dropped rather than emitted at
 * (0, 0): fewer results beat confidently wrong ones (spec §3).
 */
function toDogSpots(payload: unknown): DogSpot[] {
  const elements = isRecord(payload) ? payload.elements : undefined;
  if (!Array.isArray(elements)) {
    throw new PlaceProviderError(
      "malformed-response",
      "Overpass returned JSON without an elements array",
    );
  }

  // Keyed by id, first occurrence winning: the phase-2 union query matches a
  // feature once per clause it satisfies, and those copies are identical.
  const byId = new Map<string, DogSpot>();
  for (const element of elements as unknown[]) {
    const spot = toDogSpot(element);
    if (spot && !byId.has(spot.id)) byId.set(spot.id, spot);
  }

  return [...byId.values()];
}

function toDogSpot(element: unknown): DogSpot | undefined {
  if (!isRecord(element)) return undefined;

  const { type, id } = element;
  if (typeof type !== "string" || type === "") return undefined;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;

  const point = pointOf(element);
  if (!point) return undefined;

  const tags = isRecord(element.tags) ? element.tags : {};
  const name = tags.name;

  return {
    // Typed id, because plain OSM ids collide across node/way/relation.
    id: `${type}/${id}`,
    kind: "dog_park",
    // Absent, never a placeholder: many dog parks are genuinely unnamed and
    // the UI decides what to show instead.
    ...(typeof name === "string" && name !== "" ? { name } : {}),
    lat: point.lat,
    lon: point.lon,
    tags: toSpotTags(tags),
    // Everything here matched `leisure=dog_park`, which *is* the statement
    // that the place is for dogs.
    provenance: "designated",
  };
}

/**
 * One point per feature.
 *
 * Nodes carry their own `lat`/`lon`; ways and relations carry the centroid
 * `out center;` computed for them. A feature with neither cannot be shown on
 * a map or measured against the user, so callers get nothing at all.
 */
function pointOf(element: Record<string, unknown>): LatLon | undefined {
  const own = toPoint(element.lat, element.lon);
  if (own) return own;

  const center = element.center;
  return isRecord(center) ? toPoint(center.lat, center.lon) : undefined;
}

function toPoint(lat: unknown, lon: unknown): LatLon | undefined {
  if (typeof lat !== "number" || !Number.isFinite(lat)) return undefined;
  if (typeof lon !== "number" || !Number.isFinite(lon)) return undefined;
  return { lat, lon };
}

/**
 * The OSM tags worth showing, translated.
 *
 * A field is set only when OSM actually says something. Absent means unknown,
 * and must never be flattened into "no" (see {@link SpotTags}).
 */
function toSpotTags(tags: Record<string, unknown>): SpotTags {
  const spotTags: SpotTags = {};

  const fenced = readFenced(tags);
  if (fenced !== undefined) spotTags.fenced = fenced;

  const lit = readLit(tags);
  if (lit !== undefined) spotTags.lit = lit;

  // Passed through verbatim: OSM's surface vocabulary is open, and an enum
  // here would silently drop values we have not thought of.
  const surface = tags.surface;
  if (typeof surface === "string" && surface !== "") spotTags.surface = surface;

  return spotTags;
}

/**
 * Whether the park is enclosed.
 *
 * Mappers express this two ways: `fenced=yes|no` on the park, or
 * `barrier=fence` on its outline. `fenced` wins where both appear, being the
 * direct statement about the park rather than about one of its edges.
 * Anything else — `fenced=partial`, `barrier=hedge`, a bare `fence_type` —
 * leaves the answer unknown.
 */
function readFenced(tags: Record<string, unknown>): boolean | undefined {
  if (tags.fenced === "yes") return true;
  if (tags.fenced === "no") return false;
  if (tags.barrier === "fence") return true;
  if (tags.barrier === "no") return false;
  return undefined;
}

/**
 * Whether the park is lit after dark — in a Swedish winter, the difference
 * between usable and not.
 *
 * `lit` is not a boolean tag: `lit=24/7`, `lit=sunset-sunrise` and
 * `lit=limited` are all in use and all mean there are lamps. Only `lit=no`
 * denies it, so every other value is read as lit.
 */
function readLit(tags: Record<string, unknown>): boolean | undefined {
  const lit = tags.lit;
  if (typeof lit !== "string" || lit === "") return undefined;
  return lit !== "no";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
