import {
  BACKOFF_FACTOR,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  withFairUse,
} from "./fair-use";
import { PlaceProviderError } from "./place-provider";
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

/** A refusal of the kind Overpass sends when its slots are busy. */
function refusal(retryAfterMs?: number): PlaceProviderError {
  return new PlaceProviderError("rate-limited", "Overpass has no free slot", {
    status: 429,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Let everything that can settle settle, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("keeping the number of requests down", () => {
  it("runs at most two lookups at a time", async () => {
    let started = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        started++;
        return new Promise<DogSpot[]>(() => {
          // Never answers: the test is about what was allowed to start.
        });
      },
    });

    void guarded.findDogParks(59.3, 18.1, 3_000);
    void guarded.findDogParks(59.3, 18.1, 10_000);
    void guarded.findDogParks(59.3, 18.1, 25_000);
    await settle();

    expect(started).toBe(2);
  });

  it("starts the queued lookup as soon as a slot frees", async () => {
    const answer: ((spots: DogSpot[]) => void)[] = [];
    let started = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        started++;
        return new Promise<DogSpot[]>((resolve) => answer.push(resolve));
      },
    });

    void guarded.findDogParks(59.3, 18.1, 3_000);
    void guarded.findDogParks(59.3, 18.1, 10_000);
    void guarded.findDogParks(59.3, 18.1, 25_000);
    await settle();
    answer[0]([dogSpot("node/1")]);
    await settle();

    expect(started).toBe(3);
  });

  it("gives the slot back when a lookup fails", async () => {
    let started = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        started++;
        if (started === 1) {
          return Promise.reject(
            new PlaceProviderError("malformed-response", "not JSON"),
          );
        }
        return new Promise<DogSpot[]>(() => {
          // Never answers.
        });
      },
    });

    void failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));
    void guarded.findDogParks(59.3, 18.1, 10_000);
    void guarded.findDogParks(59.3, 18.1, 25_000);
    await settle();

    // A leaked slot would strand the third lookup forever.
    expect(started).toBe(3);
  });

  it("asks the provider for exactly what it was asked for", async () => {
    let asked: number[] = [];
    const guarded = withFairUse({
      findDogParks: (lat, lon, radiusM) => {
        asked = [lat, lon, radiusM];
        return Promise.resolve([dogSpot("node/1")]);
      },
    });

    const spots = await guarded.findDogParks(59.3293, 18.0686, 3_000);

    expect(asked).toEqual([59.3293, 18.0686, 3_000]);
    expect(spots).toEqual([dogSpot("node/1")]);
  });
});

describe("when Overpass says to slow down", () => {
  it("waits as long as the server asked before trying again", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return calls === 1
          ? Promise.reject(refusal(5_000))
          : Promise.resolve([dogSpot("node/1")]);
      },
    });

    const lookup = guarded.findDogParks(59.3, 18.1, 3_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(lookup).resolves.toEqual([dogSpot("node/1")]);
  });

  it("backs off on its own when the server gave no hint", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return calls === 1
          ? Promise.reject(refusal())
          : Promise.resolve([dogSpot("node/1")]);
      },
    });

    const lookup = guarded.findDogParks(59.3, 18.1, 3_000);
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(lookup).resolves.toEqual([dogSpot("node/1")]);
  });

  it("waits longer each time it is refused again", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return Promise.reject(refusal());
      },
    });

    const failing = failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * BACKOFF_FACTOR - 1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toBe(3);
    await failing;
  });

  it("stops trying after a capped number of retries", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return Promise.reject(refusal());
      },
    });

    const failing = failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS * 10);
    const failure = await failing;

    // One honest failure the user can act on beats an endless retry storm.
    expect(calls).toBe(MAX_RETRIES + 1);
    expect(failure.kind).toBe("rate-limited");
  });

  it("refuses to hold a lookup open for minutes on end", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return Promise.reject(refusal(10 * 60_000));
      },
    });

    const failure = await failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));

    expect(calls).toBe(1);
    // The wait survives on the error, so the UI can say how long to leave it.
    expect(failure.retryAfterMs).toBe(600_000);
  });

  it("keeps its slot while backing off, so nothing else fires at a busy service", async () => {
    const asked: number[] = [];
    const guarded = withFairUse({
      findDogParks: (_lat, _lon, radiusM) => {
        asked.push(radiusM);
        return radiusM === 3_000 && asked.length === 1
          ? Promise.reject(refusal())
          : new Promise<DogSpot[]>(() => {
              // Never answers.
            });
      },
    });

    void guarded.findDogParks(59.3, 18.1, 3_000);
    void guarded.findDogParks(59.3, 18.1, 10_000);
    void guarded.findDogParks(59.3, 18.1, 25_000);
    await settle();
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);

    // The refused lookup retried; the queued one is still waiting for a slot.
    expect(asked).toEqual([3_000, 10_000, 3_000]);
  });
});

describe("when the failure is not a refusal", () => {
  it("surfaces a timeout rather than repeating a 25-second query", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return Promise.reject(
          new PlaceProviderError("timeout", "Overpass took too long"),
        );
      },
    });

    const failure = await failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));

    // Retryable in principle, but repeating it loads a service that is
    // already struggling — the user, who can see the failure, decides.
    expect(calls).toBe(1);
    expect(failure.kind).toBe("timeout");
  });

  it("surfaces a response it cannot parse straight away", async () => {
    let calls = 0;
    const guarded = withFairUse({
      findDogParks: () => {
        calls++;
        return Promise.reject(
          new PlaceProviderError("malformed-response", "not JSON"),
        );
      },
    });

    const failure = await failureFrom(guarded.findDogParks(59.3, 18.1, 3_000));

    expect(calls).toBe(1);
    expect(failure.kind).toBe("malformed-response");
  });

  it("passes on something that is not a provider failure at all", async () => {
    const guarded = withFairUse({
      findDogParks: () => Promise.reject(new TypeError("boom")),
    });

    await expect(
      guarded.findDogParks(59.3, 18.1, 3_000),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
