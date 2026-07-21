import { withFallback } from "./fallback";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/** One plausible dog park, so a successful lookup has something to return. */
function dogSpot(id: string): DogSpot {
  return {
    id,
    kind: "dog_park",
    lat: 59.3283,
    lon: 18.0233,
    tags: {},
    provenance: "designated",
  };
}

/** One plausible hundbad, for the lookups that ask about bathing. */
function bathingSpot(id: string): DogSpot {
  return {
    id,
    kind: "bathing_spot",
    lat: 59.3106,
    lon: 18.2775,
    tags: {},
    provenance: "name-match",
  };
}

/** What Overpass sends when a query slot is not available: 504, not 429. */
function busy(retryAfterMs?: number): PlaceProviderError {
  return new PlaceProviderError("busy", "Overpass has no free slot", {
    status: 504,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** A provider that answers both lookups the same way, and counts the asking. */
function providerReturning(spots: DogSpot[]): PlaceProvider & {
  calls: () => number;
} {
  let calls = 0;
  const answer = () => {
    calls++;
    return Promise.resolve(spots);
  };
  return { calls: () => calls, findDogParks: answer, findBathingSpots: answer };
}

/** A provider that fails both lookups the same way, and counts the asking. */
function providerFailing(error: Error): PlaceProvider & {
  calls: () => number;
} {
  let calls = 0;
  const fail = () => {
    calls++;
    return Promise.reject(error);
  };
  return { calls: () => calls, findDogParks: fail, findBathingSpots: fail };
}

/** The failure a lookup produced, or a test failure if it produced none. */
async function failureFrom(
  lookup: Promise<unknown>,
): Promise<PlaceProviderError> {
  try {
    await lookup;
  } catch (error) {
    if (error instanceof PlaceProviderError) return error;
    throw error;
  }
  throw new Error("expected the lookup to fail, but it succeeded");
}

describe("when the primary answers", () => {
  it("returns its spots without asking the fallback", async () => {
    const primary = providerReturning([dogSpot("node/1")]);
    const fallback = providerReturning([dogSpot("node/2")]);

    const spots = await withFallback(primary, fallback).findDogParks(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([dogSpot("node/1")]);
    expect(fallback.calls()).toBe(0);
  });
});

describe("when the primary has no free slot", () => {
  it("falls over to the fallback and returns its spots", async () => {
    const primary = providerFailing(busy());
    const fallback = providerReturning([dogSpot("node/2")]);

    const spots = await withFallback(primary, fallback).findDogParks(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([dogSpot("node/2")]);
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("asks the fallback for the same position and radius", async () => {
    let asked: number[] = [];
    const primary = providerFailing(busy());
    const record = (lat: number, lon: number, radiusM: number) => {
      asked = [lat, lon, radiusM];
      return Promise.resolve([]);
    };
    const fallback: PlaceProvider = {
      findDogParks: record,
      findBathingSpots: record,
    };

    await withFallback(primary, fallback).findDogParks(
      59.3293,
      18.0686,
      10_000,
    );

    expect(asked).toEqual([59.3293, 18.0686, 10_000]);
  });

  it("throws the fallback's busy error when the fallback is full too", async () => {
    const primaryError = busy(2_000);
    const fallbackError = busy(9_000);
    const primary = providerFailing(primaryError);
    const fallback = providerFailing(fallbackError);

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    // Its own retryAfterMs is the fresher hint for fair use's backoff.
    expect(error).toBe(fallbackError);
  });

  it("throws the primary's original busy error when the fallback fails another way", async () => {
    const primaryError = busy(2_000);
    const primary = providerFailing(primaryError);
    const fallback = providerFailing(
      new PlaceProviderError(
        "network-unavailable",
        "Could not reach the mirror",
      ),
    );

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    // A DNS failure on the mirror does not mean Overpass itself is down —
    // the primary's "busy" is still the honest story.
    expect(error).toBe(primaryError);
  });
});

describe("failures that are not an invitation to try elsewhere", () => {
  it("propagates a rate limit without asking the fallback", async () => {
    const primaryError = new PlaceProviderError(
      "rate-limited",
      "Overpass is rate-limiting us",
      { status: 429 },
    );
    const primary = providerFailing(primaryError);
    const fallback = providerReturning([]);

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallback.calls()).toBe(0);
  });

  it("propagates a timeout without asking the fallback", async () => {
    const primaryError = new PlaceProviderError(
      "timeout",
      "Overpass did not answer in time",
    );
    const primary = providerFailing(primaryError);
    const fallback = providerReturning([]);

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallback.calls()).toBe(0);
  });

  it("propagates a server error without asking the fallback", async () => {
    const primaryError = new PlaceProviderError(
      "http-error",
      "Overpass answered 500 Internal Server Error",
      { status: 500 },
    );
    const primary = providerFailing(primaryError);
    const fallback = providerReturning([]);

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallback.calls()).toBe(0);
  });

  it("propagates something that is not a provider failure at all", async () => {
    const primary = providerFailing(new TypeError("boom"));
    const fallback = providerReturning([]);

    await expect(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fallback.calls()).toBe(0);
  });
});

describe("the bathing layer, through the same door", () => {
  it("answers from the primary's bathing spots when it has room", async () => {
    const primary: PlaceProvider = {
      // A distinct answer per layer, so a bathing lookup that quietly asked
      // about parks would show up here rather than pass.
      findDogParks: () => Promise.resolve([dogSpot("node/1")]),
      findBathingSpots: () => Promise.resolve([bathingSpot("way/4711")]),
    };
    const fallback = providerReturning([]);

    const spots = await withFallback(primary, fallback).findBathingSpots(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([bathingSpot("way/4711")]);
    expect(fallback.calls()).toBe(0);
  });

  it("falls over to the mirror's bathing spots when the primary is full", async () => {
    const primary = providerFailing(busy());
    const fallback: PlaceProvider = {
      findDogParks: () => Promise.resolve([dogSpot("node/1")]),
      findBathingSpots: () => Promise.resolve([bathingSpot("way/4711")]),
    };

    const spots = await withFallback(primary, fallback).findBathingSpots(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([bathingSpot("way/4711")]);
  });

  it("propagates a rate limit without asking the mirror", async () => {
    const primaryError = new PlaceProviderError(
      "rate-limited",
      "Overpass is rate-limiting us",
      { status: 429 },
    );
    const primary = providerFailing(primaryError);
    const fallback = providerReturning([bathingSpot("way/4711")]);

    const error = await failureFrom(
      withFallback(primary, fallback).findBathingSpots(59.3, 18.1, 3_000),
    );

    // Dodging our own rate limit by changing host is the antisocial move
    // docs/spec.md §5 warns against, whichever layer asked.
    expect(error).toBe(primaryError);
    expect(fallback.calls()).toBe(0);
  });
});
