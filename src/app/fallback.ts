import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/**
 * Trying a second Overpass instance when the first says it has no room.
 *
 * Policy about *whom* to ask, layered on two {@link PlaceProvider}s that each
 * do exactly one query. Overpass answers 504 when every query slot on an
 * instance is taken; a different instance is a different pool of slots, so
 * asking it is far more likely to help than waiting for this one to free up —
 * and it is the politer move, next to retrying into a server that has already
 * said it has no room. docs/spec.md §5 names `overpass.kumi.systems` as such
 * a mirror and requires the endpoint be configurable. Its usage policy
 * (checked 2026-07-21) is open to any project, commercial included, sets no
 * formal rate limit, and runs on a fair-share trust model — occasional
 * failover from a personal-use app sits comfortably inside that.
 *
 * Only a `busy` failure reaches the fallback. `rate-limited` is *us* asking
 * too often, and dodging our own rate limit by moving to another host is
 * exactly the antisocial behaviour docs/spec.md §5 warns against, so it
 * passes straight through untouched. `timeout`, `network-unavailable` and
 * `malformed-response` are none of them the primary's capacity, and a second
 * host fixes none of them either — they pass straight through too.
 *
 * If the fallback also fails, which error the caller sees depends on how.
 * Busy again throws the *fallback's* error, because its `retryAfterMs` is the
 * fresher hint for the backoff this composes with. Anything else throws the
 * *primary's* original busy error: the primary really did answer 504, and
 * that is the true story to tell — a DNS failure on the mirror's side
 * surfacing as `network-unavailable` would tell the user they are offline
 * when they are not.
 *
 * This belongs inside fair use, not outside it. Fair use's retry loop treats
 * the pair as a single provider, so the mirror gets tried before any backoff
 * wait — the other pool of slots first, then wait, which is the entire point.
 * It also keeps the request budget structural rather than open-ended: this
 * decorator adds at most one extra request per attempt, and only when the
 * primary said busy, so fair use's three attempts — one plus its two retries
 * — become at most six real requests instead of three. Each retry round is
 * still preceded by fair use's own backoff, and the expanding search stops
 * widening at the first radius that fails, so fallback and retry cannot
 * multiply against each other into an unbounded burst.
 */
export function withFallback(
  primary: PlaceProvider,
  fallback: PlaceProvider,
): PlaceProvider {
  // Both layers get the identical policy: an instance with no free slot has
  // none for either question, and the mirror is the answer to both.
  return {
    findDogParks: (lat, lon, radiusM) =>
      askEither(
        () => primary.findDogParks(lat, lon, radiusM),
        () => fallback.findDogParks(lat, lon, radiusM),
      ),
    findBathingSpots: (lat, lon, radiusM) =>
      askEither(
        () => primary.findBathingSpots(lat, lon, radiusM),
        () => fallback.findBathingSpots(lat, lon, radiusM),
      ),
  };
}

/**
 * Asks the primary, then the fallback once if the primary had no room — and
 * decides which error tells the truth when the fallback fails too.
 */
async function askEither(
  askPrimary: () => Promise<DogSpot[]>,
  askFallback: () => Promise<DogSpot[]>,
): Promise<DogSpot[]> {
  let primaryBusy: PlaceProviderError;
  try {
    return await askPrimary();
  } catch (error) {
    if (!isBusy(error)) throw error;
    primaryBusy = error;
  }

  try {
    return await askFallback();
  } catch (error) {
    throw isBusy(error) ? error : primaryBusy;
  }
}

/** Whether a failure means "no free slot right now", specifically. */
function isBusy(error: unknown): error is PlaceProviderError {
  return error instanceof PlaceProviderError && error.kind === "busy";
}
