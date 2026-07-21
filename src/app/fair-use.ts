import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/**
 * Being a good guest on a free shared service (docs/spec.md §5).
 *
 * Policy about *how often* to ask, layered on a {@link PlaceProvider} that
 * does exactly one query. A personal-use app sits far below any Overpass
 * limit; these guards exist so that a spike in usage degrades politely
 * instead of getting the app blocked.
 *
 * The client-side abort that matches the query's own `[timeout:25]` is not
 * here — it belongs to the request, and lives in overpass.ts.
 */

/** How many requests may be in flight at once. The ceiling from spec §5. */
export const MAX_CONCURRENT_REQUESTS = 2;

/**
 * How many extra attempts a refused request gets.
 *
 * Two, so the worst case is three requests and about six seconds of waiting.
 * A retry storm against a service that just said "not now" is worse than one
 * honest failure, and the UI already offers the user their own retry (§7.6).
 */
export const MAX_RETRIES = 2;

/**
 * How long to wait before the first retry, when the server gave no hint.
 *
 * Overpass refuses with 429 or 504 when its slots are busy, which usually
 * clears in seconds — but coming back in under a second is indistinguishable
 * from not having backed off at all.
 */
export const INITIAL_BACKOFF_MS = 2_000;

/** How much longer each successive wait is. */
export const BACKOFF_FACTOR = 2;

/**
 * The longest we will hold a lookup open while waiting.
 *
 * When Overpass asks for longer than this, we stop rather than wait: a user
 * watching a spinner for minutes is worse served than one told plainly that
 * the service is busy. The error keeps its `retryAfterMs`, so the UI can say
 * how long.
 */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Wraps a provider in the fair-use guards.
 *
 * Each wrapper owns its own queue, so wrap the provider once and share it —
 * two wrappers around the same service are two independent limits.
 */
export function withFairUse(provider: PlaceProvider): PlaceProvider {
  const slots = createSlots(MAX_CONCURRENT_REQUESTS);

  return {
    async findDogParks(lat, lon, radiusM) {
      await slots.take();
      try {
        return await attempt(provider, lat, lon, radiusM);
      } finally {
        slots.release();
      }
    },
  };
}

/**
 * One lookup, retried while the server is telling us to slow down.
 *
 * The slot is held for the whole thing, backoff included. Releasing it would
 * let a queued lookup fire at a service that has just refused us, which is
 * the polling the spec rules out.
 */
async function attempt(
  provider: PlaceProvider,
  lat: number,
  lon: number,
  radiusM: number,
): Promise<DogSpot[]> {
  for (let retries = 0; ; retries++) {
    try {
      return await provider.findDogParks(lat, lon, radiusM);
    } catch (error) {
      const wait = waitBeforeRetry(error, retries);
      if (wait === undefined) throw error;
      await sleep(wait);
    }
  }
}

/**
 * How long to wait before trying again, or nothing if we should not.
 *
 * Only a refusal is retried here. A timeout or an unreachable network is
 * retryable in principle, but repeating a 25-second query against a service
 * that is already struggling adds load exactly when it is least welcome — and
 * the user, who can see the failure, is better placed to decide.
 */
function waitBeforeRetry(
  error: unknown,
  retriesSoFar: number,
): number | undefined {
  if (!(error instanceof PlaceProviderError)) return undefined;
  // Both mean "not now": one because we asked too often, one because the
  // shared instance has no free slot. Waiting is the right answer to each.
  if (error.kind !== "rate-limited" && error.kind !== "busy") return undefined;
  if (retriesSoFar >= MAX_RETRIES) return undefined;

  // The server's own instruction beats our guess whenever it gave one.
  const wait =
    error.retryAfterMs ?? INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** retriesSoFar;

  return wait > MAX_BACKOFF_MS ? undefined : wait;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Slots {
  /** Resolves once there is room to send a request. */
  take(): Promise<void>;
  /** Gives the slot back, starting whoever has waited longest. */
  release(): void;
}

/** A counting gate with a FIFO queue: no polling, no timers, no starvation. */
function createSlots(limit: number): Slots {
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  return {
    take() {
      if (inFlight < limit) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      // Handed straight over rather than freed and re-taken: the count never
      // dips, so a burst of callers cannot slip past the limit together.
      if (next) next();
      else inFlight--;
    },
  };
}
