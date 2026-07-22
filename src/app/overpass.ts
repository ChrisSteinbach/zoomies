import {
  BATHING_FEATURE_TAGS,
  DOG_ALLOWED_VALUES,
  DOG_PARK_TAG,
  HUNDBAD_NAME_SUBSTRING,
  NAMED_FEATURE_FAMILIES,
  asBathingSpot,
  asDogPark,
  toSpotTags,
} from "./osm-tags";
import type { SpotSkeleton } from "./osm-tags";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot, LatLon } from "./types";

/**
 * The MVP's data source: the public Overpass API (docs/spec.md §5, Option A).
 *
 * Every Overpass-shaped idea — the query language, `elements`, node/way/
 * relation, HTTP status codes — is confined to this file. What the layers
 * *mean* is not here: the tag vocabulary and the tags→spot translation live
 * in osm-tags.ts, shared with the offline dataset pipeline, so the two
 * sources cannot drift apart. What leaves is {@link DogSpot} and
 * {@link PlaceProviderError}, so the offline provider can take this file's
 * place without the UI noticing.
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
      return toSpots(payload, toDogPark);
    },

    async findBathingSpots(lat, lon, radiusM) {
      const query = buildBathingQuery(lat, lon, radiusM);
      const payload = await postQuery(fetchImpl, endpoint, query);
      return toSpots(payload, toBathingSpot);
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
  const park = `nwr["${DOG_PARK_TAG.key}"="${DOG_PARK_TAG.value}"]`;
  return [
    `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`,
    `${park}(around:${around(lat, lon, radiusM)});`,
    "out center;",
  ].join("\n");
}

/**
 * The bathing-spot query: the union of docs/spec.md §4.3, because there is no
 * single primary tag for a hundbad.
 *
 * Every clause is derived from the shared vocabulary in osm-tags.ts — the
 * tagged patterns from {@link BATHING_FEATURE_TAGS} and
 * {@link DOG_ALLOWED_VALUES}, the Sweden-specific name fallback from
 * {@link HUNDBAD_NAME_SUBSTRING} bounded to the
 * {@link NAMED_FEATURE_FAMILIES} — so this query and the offline converter's
 * predicates are two spellings of one rule. The fallback matters because many
 * hundbad are mapped as generic features with "hundbad" in the name and no
 * `dog=*` tag at all; without it Swedish coverage is close to useless, which
 * is the one thing this app cannot afford (§2.1). It also finds false
 * positives, which is why what it finds is labelled `name-match` rather than
 * presented as a fact about dogs.
 *
 * A feature can satisfy several clauses at once; deduplication is
 * {@link toSpots}'s job.
 */
function buildBathingQuery(lat: number, lon: number, radiusM: number): string {
  const near = around(lat, lon, radiusM);
  const allowsDogs = `["dog"~"^(${DOG_ALLOWED_VALUES.join("|")})$"]`;
  const taggedBathing = BATHING_FEATURE_TAGS.map(
    ({ key, value }) =>
      `  nwr["${key}"="${value}"]${allowsDogs}(around:${near});`,
  );
  const namedHundbad = NAMED_FEATURE_FAMILIES.map(
    (family) =>
      `  nwr["${family}"]["name"~"${HUNDBAD_NAME_SUBSTRING}",i](around:${near});`,
  );
  return [
    `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`,
    "(",
    ...taggedBathing,
    ...namedHundbad,
    ");",
    "out center;",
  ].join("\n");
}

/** The arguments of an Overpass `(around:…)` filter: radius, then centre. */
function around(lat: number, lon: number, radiusM: number): string {
  return `${Math.round(radiusM)},${formatCoord(lat)},${formatCoord(lon)}`;
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
 * The Overpass payload as dog spots, translated by `toSpot`.
 *
 * Elements we cannot place on a map are dropped rather than emitted at
 * (0, 0): fewer results beat confidently wrong ones (spec §3), and so are
 * elements the translator itself rejects.
 */
function toSpots(
  payload: unknown,
  toSpot: (element: unknown) => DogSpot | undefined,
): DogSpot[] {
  const elements = isRecord(payload) ? payload.elements : undefined;
  if (!Array.isArray(elements)) {
    throw new PlaceProviderError(
      "malformed-response",
      "Overpass returned JSON without an elements array",
    );
  }

  // Keyed by id, first occurrence winning: the bathing union query matches a
  // feature once per clause it satisfies, and those copies are identical —
  // provenance is read from the element's own tags, never from which clause
  // produced it, so which copy wins cannot change the answer.
  const byId = new Map<string, DogSpot>();
  for (const element of elements as unknown[]) {
    const spot = toSpot(element);
    if (spot && !byId.has(spot.id)) byId.set(spot.id, spot);
  }

  return [...byId.values()];
}

/** What every feature translates to, before anything kind-specific. */
interface CommonSpot {
  /** The fields shared by both layers: identity, name, position, tags. */
  spot: SpotSkeleton;
  /** The element's raw OSM tags, for the decisions that differ by kind. */
  tags: Record<string, unknown>;
}

/**
 * The element→spot skeleton both layers share.
 *
 * What differs between a park and a bathing spot is the *claim* made about
 * dogs — kind, provenance, seasonal rules — not how a feature is read off the
 * wire, so that part is written once.
 */
function toCommonSpot(element: unknown): CommonSpot | undefined {
  if (!isRecord(element)) return undefined;

  const { type, id } = element;
  if (typeof type !== "string" || type === "") return undefined;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;

  const point = pointOf(element);
  if (!point) return undefined;

  const tags = isRecord(element.tags) ? element.tags : {};
  const name = tags.name;

  return {
    spot: {
      // Typed id, because plain OSM ids collide across node/way/relation.
      id: `${type}/${id}`,
      // Absent, never a placeholder: many dog parks are genuinely unnamed and
      // the UI decides what to show instead.
      ...(typeof name === "string" && name !== "" ? { name } : {}),
      lat: point.lat,
      lon: point.lon,
      tags: toSpotTags(tags),
    },
    tags,
  };
}

/** A dog-park element as a spot. The claim itself is {@link asDogPark}'s. */
function toDogPark(element: unknown): DogSpot | undefined {
  const common = toCommonSpot(element);
  return common && asDogPark(common.spot);
}

/** A bathing element as a spot, graded — or dropped — by its own tags. */
function toBathingSpot(element: unknown): DogSpot | undefined {
  const common = toCommonSpot(element);
  return common && asBathingSpot(common.spot, common.tags);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
