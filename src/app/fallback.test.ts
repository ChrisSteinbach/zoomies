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

/** What Overpass sends when a query slot is not available: 504, not 429. */
function busy(retryAfterMs?: number): PlaceProviderError {
  return new PlaceProviderError("busy", "Overpass has no free slot", {
    status: 504,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** A provider that always answers the same way. */
function providerReturning(spots: DogSpot[]): PlaceProvider {
  return { findDogParks: () => Promise.resolve(spots) };
}

/** A provider that always fails the same way. */
function providerFailing(error: Error): PlaceProvider {
  return { findDogParks: () => Promise.reject(error) };
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
    let fallbackCalls = 0;
    const primary = providerReturning([dogSpot("node/1")]);
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([dogSpot("node/2")]);
      },
    };

    const spots = await withFallback(primary, fallback).findDogParks(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([dogSpot("node/1")]);
    expect(fallbackCalls).toBe(0);
  });
});

describe("when the primary has no free slot", () => {
  it("falls over to the fallback and returns its spots", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary: PlaceProvider = {
      findDogParks: () => {
        primaryCalls++;
        return Promise.reject(busy());
      },
    };
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([dogSpot("node/2")]);
      },
    };

    const spots = await withFallback(primary, fallback).findDogParks(
      59.3,
      18.1,
      3_000,
    );

    expect(spots).toEqual([dogSpot("node/2")]);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  it("asks the fallback for the same position and radius", async () => {
    let asked: number[] = [];
    const primary = providerFailing(busy());
    const fallback: PlaceProvider = {
      findDogParks: (lat, lon, radiusM) => {
        asked = [lat, lon, radiusM];
        return Promise.resolve([]);
      },
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
    let fallbackCalls = 0;
    const primaryError = new PlaceProviderError(
      "rate-limited",
      "Overpass is rate-limiting us",
      { status: 429 },
    );
    const primary = providerFailing(primaryError);
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([]);
      },
    };

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("propagates a timeout without asking the fallback", async () => {
    let fallbackCalls = 0;
    const primaryError = new PlaceProviderError(
      "timeout",
      "Overpass did not answer in time",
    );
    const primary = providerFailing(primaryError);
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([]);
      },
    };

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("propagates a server error without asking the fallback", async () => {
    let fallbackCalls = 0;
    const primaryError = new PlaceProviderError(
      "http-error",
      "Overpass answered 500 Internal Server Error",
      { status: 500 },
    );
    const primary = providerFailing(primaryError);
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([]);
      },
    };

    const error = await failureFrom(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    );

    expect(error).toBe(primaryError);
    expect(fallbackCalls).toBe(0);
  });

  it("propagates something that is not a provider failure at all", async () => {
    let fallbackCalls = 0;
    const primary = providerFailing(new TypeError("boom"));
    const fallback: PlaceProvider = {
      findDogParks: () => {
        fallbackCalls++;
        return Promise.resolve([]);
      },
    };

    await expect(
      withFallback(primary, fallback).findDogParks(59.3, 18.1, 3_000),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fallbackCalls).toBe(0);
  });
});
