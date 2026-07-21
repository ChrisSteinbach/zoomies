import type { DogSpot } from "./types";

/**
 * The one way the app gets data.
 *
 * Everything above this line is source-agnostic; everything below it is
 * replaceable. The MVP implements this against the live Overpass API; phase 4
 * replaces it with a local extract built from a Geofabrik download
 * (docs/spec.md §5, Option B) without the UI noticing.
 *
 * That only holds if no Overpass-shaped type ever leaks through here. If one
 * does, the seam has bought nothing and the offline path becomes a rewrite.
 */
export interface PlaceProvider {
  /**
   * Dog parks within `radiusM` metres of the given position, in no
   * particular order — sorting is the caller's job, because it depends on
   * the user's live position rather than the query centre.
   *
   * Returns an empty array when there is genuinely nothing there. That is a
   * legitimate answer in a sparsely mapped region, not a failure, and the UI
   * presents it differently from one (docs/spec.md §3).
   *
   * Throws {@link PlaceProviderError} for every failure mode.
   */
  findDogParks(lat: number, lon: number, radiusM: number): Promise<DogSpot[]>;
}

/**
 * Why a lookup failed.
 *
 * The UI has to fail "visibly and politely" with a retry affordance
 * (docs/spec.md §7.6), and it can only do that if the data layer says what
 * went wrong instead of collapsing everything into one generic throw.
 */
export type PlaceProviderErrorKind =
  /** The request exceeded its deadline. Overpass declares `[timeout:25]`;
   *  the client aborts on a matching deadline of its own. */
  | "timeout"
  /** We are asking too often — HTTP 429, or Overpass's "slot available
   *  after" rejection. Back off; do not retry immediately. */
  | "rate-limited"
  /** Any other non-2xx response. `status` carries the code. */
  | "http-error"
  /** The request never reached a server: offline, DNS failure, CORS. */
  | "network-unavailable"
  /** A 2xx response whose body is not the JSON we expect. Real: Overpass
   *  answers some malformed requests with an HTML error page. */
  | "malformed-response";

/** Failure modes worth retrying without the user changing anything. */
const ALWAYS_RETRYABLE: ReadonlySet<PlaceProviderErrorKind> = new Set([
  "timeout",
  "rate-limited",
  "network-unavailable",
]);

export interface PlaceProviderErrorOptions {
  /** HTTP status, for `http-error` and `rate-limited`. */
  status?: number;
  /** How long to wait before retrying, when the server told us — parsed
   *  from `Retry-After`. Consumed by the fair-use backoff. */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * A failure from a {@link PlaceProvider}, of a known kind.
 *
 * Part of the interface contract rather than the Overpass client's private
 * business: an offline provider reports the same shapes, so the UI's error
 * handling survives the swap.
 */
export class PlaceProviderError extends Error {
  readonly kind: PlaceProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: PlaceProviderErrorKind,
    message: string,
    options: PlaceProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PlaceProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * Whether retrying the identical request could plausibly succeed.
   *
   * Server faults (5xx) are worth another go; a request we got wrong (4xx)
   * will fail the same way forever, and a body we cannot parse will not
   * reparse.
   */
  get retryable(): boolean {
    if (ALWAYS_RETRYABLE.has(this.kind)) return true;
    if (this.kind === "http-error") return (this.status ?? 0) >= 500;
    return false;
  }
}
