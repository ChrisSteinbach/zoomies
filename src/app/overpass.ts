import { parseDogConditional } from "./dog-conditional";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type {
  DogSpot,
  LatLon,
  Provenance,
  SeasonalRule,
  SpotTags,
} from "./types";

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
  return [
    `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`,
    `nwr["leisure"="dog_park"](around:${around(lat, lon, radiusM)});`,
    "out center;",
  ].join("\n");
}

/**
 * The tag families the name-regex fallback is allowed to search.
 *
 * Not in the spec's version of the query, and load-bearing: a bare
 * `nwr["name"~"hundbad",i]` runs the regex over every named object in the
 * disc — every street, shop and bus stop — and, measured on 2026-07-21, that
 * times out inside the query's own 25-second budget at the 25 km radius
 * around central Stockholm (the server gave up at 31 s). Since the widest
 * ring is exactly where a thin layer ends up, the unbounded clause would turn
 * "no bathing spots within 25 km" into a permanent error in the one city the
 * spec requires to work (§2.1).
 *
 * Requiring an indexed tag family first keeps the regex to feature-shaped
 * objects. The cost of the bound: a hundbad whose element carries a name and
 * none of these families is out of reach — and such an element would also
 * give us nothing to render or grade, so the recall given up is places the
 * app could only have pointed at, not described.
 */
const NAMED_FEATURE_FAMILIES = [
  "natural",
  "leisure",
  "amenity",
  "man_made",
  "place",
] as const;

/**
 * The bathing-spot query: the union of docs/spec.md §4.3, because there is no
 * single primary tag for a hundbad.
 *
 * The first three clauses are the tagged patterns — a bathing place, a beach
 * or a swimming area that says something about dogs. The rest are the
 * Sweden-specific fallback, the case-insensitive name regex bounded to the
 * {@link NAMED_FEATURE_FAMILIES}: many hundbad are mapped as generic features
 * with "hundbad" in the name and no `dog=*` tag at all, so without the
 * fallback Swedish coverage is close to useless — which is the one thing this
 * app cannot afford (§2.1). It also finds false positives, which is why what
 * it finds is labelled `name-match` rather than presented as a fact about
 * dogs.
 *
 * A feature can satisfy several clauses at once; deduplication is
 * {@link toSpots}'s job.
 */
function buildBathingQuery(lat: number, lon: number, radiusM: number): string {
  const near = around(lat, lon, radiusM);
  const allowsDogs = '["dog"~"^(yes|designated)$"]';
  const namedHundbad = NAMED_FEATURE_FAMILIES.map(
    (family) => `  nwr["${family}"]["name"~"hundbad",i](around:${near});`,
  );
  return [
    `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`,
    "(",
    `  nwr["leisure"="bathing_place"]${allowsDogs}(around:${near});`,
    `  nwr["natural"="beach"]${allowsDogs}(around:${near});`,
    `  nwr["leisure"="swimming_area"]${allowsDogs}(around:${near});`,
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
  spot: Omit<DogSpot, "kind" | "provenance" | "seasonal">;
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

function toDogPark(element: unknown): DogSpot | undefined {
  const common = toCommonSpot(element);
  if (!common) return undefined;

  return {
    ...common.spot,
    kind: "dog_park",
    // Everything here matched `leisure=dog_park`, which *is* the statement
    // that the place is for dogs.
    provenance: "designated",
    // No `seasonal`, deliberately: `dog:conditional` describes a beach ban
    // season, and a dog park is not seasonally closed to dogs. Reading the
    // tag here would invent a caveat the park layer has no business making.
  };
}

function toBathingSpot(element: unknown): DogSpot | undefined {
  const common = toCommonSpot(element);
  if (!common) return undefined;

  const provenance = bathingProvenance(common.tags);
  if (!provenance) return undefined;

  const seasonal = seasonalRule(common.tags);

  return {
    ...common.spot,
    kind: "bathing_spot",
    provenance,
    ...(seasonal ? { seasonal } : {}),
  };
}

/**
 * How strong a claim this feature makes about dogs — or nothing at all, when
 * it says dogs are not welcome, in which case the caller drops it.
 *
 * Read from the element's own tags rather than from which union clause
 * matched, because Overpass does not say which one did.
 *
 * `dog=no` is the exclusion that matters: such a feature can only have
 * reached us through the name regex, and a beach called "Hundbadet" that has
 * since been tagged as banning dogs is precisely the confidently wrong pin
 * the spec forbids (§3). Dropping it costs a result; showing it costs someone
 * a wasted trip, or a fine.
 */
function bathingProvenance(
  tags: Record<string, unknown>,
): Provenance | undefined {
  const dog = tags.dog;

  // Specifically intended for dogs: a dog beach (§4.3).
  if (dog === "designated") return "designated";
  // Dogs are allowed, though the place is not for them. `leashed` and
  // `unleashed` can only arrive through the name clause — the tagged clauses
  // match `yes|designated` alone — but they still say dogs belong here.
  if (dog === "yes" || dog === "leashed" || dog === "unleashed") {
    return "permitted";
  }
  if (dog === "no") return undefined;

  // No `dog` tag, or a value nobody has thought about: the word in the name
  // is the only reason this feature is in the answer, and the UI must say so.
  return "name-match";
}

/**
 * The seasonal ban OSM records for this feature, when it records one.
 *
 * Absent `dog:conditional` leaves the field off entirely rather than
 * asserting "no restriction" — the UI's verify-signage caveat is what covers
 * that case (§4.5.3), and a value this app cannot read still comes back as
 * `unparsed` so the caveat sharpens rather than disappears.
 */
function seasonalRule(tags: Record<string, unknown>): SeasonalRule | undefined {
  const conditional = tags["dog:conditional"];
  if (typeof conditional !== "string" || conditional === "") return undefined;
  return parseDogConditional(conditional);
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
