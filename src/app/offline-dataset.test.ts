import {
  DATASET_FETCH_TIMEOUT_MS,
  DATASET_SCHEMA_VERSION,
  DEFAULT_DATASET_URL,
  createDatasetLoader,
  withOfflineDataset,
} from "./offline-dataset";
import type { Dataset, DatasetStore } from "./offline-dataset";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

// Every query in this file asks from central Stockholm, (59.33, 18.06). The
// dataset's coverage square below keeps its nearest edge — the western one,
// 0.56° of longitude ≈ 32 km at this latitude — well clear of a 3 or 10 km
// circle, so those searches are answered offline and a 35 km one is not.

/** ~1.8 km south-east of the query point: inside every radius asked here. */
const NEARBY_PARK: DogSpot = {
  id: "way/58082448",
  kind: "dog_park",
  name: "Björns Trädgårds hundrastgård",
  lat: 59.3157,
  lon: 18.0737,
  tags: { fenced: true },
  provenance: "designated",
};

/** 0.045° of latitude due north ≈ 5.0 km by haversine: outside a 3 km
 *  search, inside a 10 km one. Unnamed, like many real dog parks. */
const FIVE_KM_PARK: DogSpot = {
  id: "node/4711",
  kind: "dog_park",
  lat: 59.375,
  lon: 18.06,
  tags: {},
  provenance: "designated",
};

/** ~2.0 km west: the bathing layer's nearby answer. */
const NEARBY_BATHING: DogSpot = {
  id: "way/333",
  kind: "bathing_spot",
  name: "Smedsuddens hundbad",
  lat: 59.32,
  lon: 18.03,
  tags: { surface: "sand" },
  provenance: "name-match",
};

/** ~0.8 km away, carrying the Stockholm summer ban (docs/spec.md §4.5.3). */
const SEASONAL_BATHING: DogSpot = {
  id: "way/444",
  kind: "bathing_spot",
  name: "Norr Mälarstrands hundbad",
  lat: 59.325,
  lon: 18.05,
  tags: {},
  provenance: "designated",
  seasonal: {
    kind: "ban",
    from: { month: 6, day: 1 },
    to: { month: 8, day: 31 },
  },
};

/** ~1.1 km north: a park only this week's pipeline run knows about. */
const NEW_PARK: DogSpot = {
  id: "node/7777",
  kind: "dog_park",
  name: "Vasaparkens hundrastgård",
  lat: 59.34,
  lon: 18.06,
  tags: {},
  provenance: "designated",
};

/** What the live stack answers when a test hands over to it. Copenhagen —
 *  fittingly, ground the Sweden dataset cannot answer for. */
const FAELLED_PARK: DogSpot = {
  id: "node/999",
  kind: "dog_park",
  name: "Fælledparkens hundegård",
  lat: 55.7042,
  lon: 12.5714,
  tags: {},
  provenance: "designated",
};

/** A valid schema-1 dataset, fresh objects each call so tests can bend it. */
function stockholmDataset(): Dataset {
  return {
    schema: DATASET_SCHEMA_VERSION,
    generatedAt: "2026-07-20T03:00:00Z",
    region: "europe/sweden",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    coverage: {
      include: [
        [
          [58.9, 17.5],
          [58.9, 18.7],
          [59.7, 18.7],
          [59.7, 17.5],
        ],
      ],
      exclude: [],
    },
    spots: [NEARBY_PARK, FIVE_KM_PARK, NEARBY_BATHING, SEASONAL_BATHING],
  };
}

/** An in-memory {@link DatasetStore}, standing in for IndexedDB. */
function fakeStore(): DatasetStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key)),
    set: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
  };
}

/** A `fetch` that always answers 200 with this payload as JSON. */
function respondingWith(payload: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

/** A `fetch` that answers with a body and status exactly as given. */
function respondingRaw(body: string, init: ResponseInit): typeof fetch {
  return () => Promise.resolve(new Response(body, init));
}

/** A live provider the test expects to stay untouched: any call fails it. */
function liveNeverAsked(): PlaceProvider {
  const refuse = (): Promise<DogSpot[]> => {
    throw new Error("the offline path should have answered this lookup");
  };
  return { findDogParks: refuse, findBathingSpots: refuse };
}

/** A live provider answering every lookup the same way, counting the asking. */
function liveReturning(spots: DogSpot[]): PlaceProvider & {
  calls: () => number;
} {
  let calls = 0;
  const answer = () => {
    calls++;
    return Promise.resolve(spots);
  };
  return { calls: () => calls, findDogParks: answer, findBathingSpots: answer };
}

/** Waits out the un-awaited background refresh: two macrotask turns cover
 *  its fetch, body read, validation and store write. */
async function afterBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("answering from the dataset", () => {
  it("answers a parks lookup from the dataset without asking the live provider", async () => {
    const loader = createDatasetLoader({
      fetchImpl: respondingWith(stockholmDataset()),
      store: fakeStore(),
    });
    const provider = withOfflineDataset(loader, liveNeverAsked());

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([NEARBY_PARK]);
  });

  it("does not answer a bathing lookup with the dataset's parks", async () => {
    const loader = createDatasetLoader({
      fetchImpl: respondingWith(stockholmDataset()),
      store: fakeStore(),
    });
    const provider = withOfflineDataset(loader, liveNeverAsked());

    const spots = await provider.findBathingSpots(59.33, 18.06, 3_000);

    // Both layers live in one file; `kind` keeps them apart — and the
    // seasonal ban comes through the load intact.
    expect(spots).toEqual([NEARBY_BATHING, SEASONAL_BATHING]);
  });

  it("leaves out a park beyond the asked radius", async () => {
    const loader = createDatasetLoader({
      fetchImpl: respondingWith(stockholmDataset()),
      store: fakeStore(),
    });
    const provider = withOfflineDataset(loader, liveNeverAsked());

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    // FIVE_KM_PARK sits 0.045° north ≈ 5.0 km: in the file, not the answer.
    expect(spots.map((spot) => spot.id)).not.toContain(FIVE_KM_PARK.id);
  });

  it("finds that park again once the search widens past it", async () => {
    const loader = createDatasetLoader({
      fetchImpl: respondingWith(stockholmDataset()),
      store: fakeStore(),
    });
    const provider = withOfflineDataset(loader, liveNeverAsked());

    const spots = await provider.findDogParks(59.33, 18.06, 10_000);

    expect(spots).toEqual([NEARBY_PARK, FIVE_KM_PARK]);
  });
});

describe("handing over to the live provider", () => {
  it("returns the live answer verbatim for a query outside coverage", async () => {
    const answer = [FAELLED_PARK];
    const live = liveReturning(answer);
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store: fakeStore(),
      }),
      live,
    );

    // Copenhagen: inside Sweden's bounding box, outside its coverage — the
    // exact traveller the polygon test exists for (coverage.ts).
    const spots = await provider.findDogParks(55.6761, 12.5683, 3_000);

    expect(spots).toBe(answer);
  });

  it("hands over when the circle pokes past the coverage edge, centre inside", async () => {
    const answer = [FAELLED_PARK];
    const live = liveReturning(answer);
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store: fakeStore(),
      }),
      live,
    );

    // The nearest edge is ~32 km west; a 35 km circle reaches ground the
    // dataset cannot vouch for, so the whole question goes live.
    const spots = await provider.findDogParks(59.33, 18.06, 35_000);

    expect(spots).toBe(answer);
  });

  it("lets the live provider's failure reach the caller untouched", async () => {
    const failure = new PlaceProviderError("timeout", "Overpass took too long");
    const reject = () => Promise.reject<DogSpot[]>(failure);
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store: fakeStore(),
      }),
      { findDogParks: reject, findBathingSpots: reject },
    );

    // Delegated because Copenhagen is outside coverage; the offline layer
    // must not re-wrap what the UI already knows how to handle.
    await expect(provider.findDogParks(55.6761, 12.5683, 3_000)).rejects.toBe(
      failure,
    );
  });
});

describe("when there is no dataset to be had", () => {
  it("falls back to live when the dataset fetch rejects", async () => {
    const live = liveReturning([FAELLED_PARK]);
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
        store: fakeStore(),
      }),
      live,
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([FAELLED_PARK]);
    expect(live.calls()).toBe(1);
  });

  it("reaches the network again on the next lookup after a failed load", async () => {
    let calls = 0;
    const failingOnce: typeof fetch = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(new Response(JSON.stringify(stockholmDataset())));
    };
    const live = liveReturning([FAELLED_PARK]);
    const provider = withOfflineDataset(
      createDatasetLoader({ fetchImpl: failingOnce, store: fakeStore() }),
      live,
    );

    const first = await provider.findDogParks(59.33, 18.06, 3_000);
    const second = await provider.findDogParks(59.33, 18.06, 3_000);

    // The failure was not remembered: the retry button's whole path.
    expect(first).toEqual([FAELLED_PARK]);
    expect(second).toEqual([NEARBY_PARK]);
    expect(live.calls()).toBe(1);
  });

  it("gives up on a download that never finishes, and answers live", async () => {
    vi.useFakeTimers();
    try {
      const live = liveReturning([FAELLED_PARK]);
      const provider = withOfflineDataset(
        createDatasetLoader({
          fetchImpl: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              });
            }),
          store: fakeStore(),
        }),
        live,
      );

      const asking = provider.findDogParks(59.33, 18.06, 3_000);
      await vi.advanceTimersByTimeAsync(DATASET_FETCH_TIMEOUT_MS);

      expect(await asking).toEqual([FAELLED_PARK]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats the dataset branch not existing yet as having no dataset", async () => {
    const live = liveReturning([FAELLED_PARK]);
    const provider = withOfflineDataset(
      createDatasetLoader({
        // The designed first-rollout state: no pipeline has run, the
        // `dataset` branch does not exist, raw.githubusercontent answers 404.
        fetchImpl: respondingRaw("404: Not Found", { status: 404 }),
        store: fakeStore(),
      }),
      live,
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([FAELLED_PARK]);
  });

  it("falls back to live when the body is not JSON", async () => {
    const live = liveReturning([FAELLED_PARK]);
    const provider = withOfflineDataset(
      createDatasetLoader({
        // A captive portal, or a CDN error page with a cheerful 200.
        fetchImpl: respondingRaw("<html><body>Hotel WiFi</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
        store: fakeStore(),
      }),
      live,
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([FAELLED_PARK]);
  });

  it("falls back to live when the file speaks a schema this app cannot read", async () => {
    const live = liveReturning([FAELLED_PARK]);
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith({ ...stockholmDataset(), schema: 2 }),
        store: fakeStore(),
      }),
      live,
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    // Guessing at a future format would put unvouched-for pins on the map.
    expect(spots).toEqual([FAELLED_PARK]);
  });
});

describe("validating what arrived", () => {
  it("drops a spot it cannot vouch for and answers with the rest", async () => {
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith({
          ...stockholmDataset(),
          // A park with no position cannot go on a map (spec §3) — but one
          // bad row must not cost the whole file.
          spots: [NEARBY_PARK, { id: "node/9", kind: "dog_park" }],
        }),
        store: fakeStore(),
      }),
      liveNeverAsked(),
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([NEARBY_PARK]);
  });

  it("keeps a spot whose seasonal rule is garbled, minus the rule", async () => {
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith({
          ...stockholmDataset(),
          spots: [
            {
              ...NEARBY_BATHING,
              seasonal: {
                kind: "ban",
                from: { month: 13, day: 1 },
                to: "Aug",
              },
            },
          ],
        }),
        store: fakeStore(),
      }),
      liveNeverAsked(),
    );

    const spots = await provider.findBathingSpots(59.33, 18.06, 3_000);

    // A half-read ban could tell the UI today is fine at a beach where it is
    // not; absence only degrades to the caveat every bathing spot carries.
    expect(spots).toHaveLength(1);
    expect(spots[0].seasonal).toBeUndefined();
    expect(spots).toEqual([NEARBY_BATHING]);
  });
});

describe("the stored copy", () => {
  it("keeps a network load for later sessions", async () => {
    const store = fakeStore();
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store,
      }),
      liveNeverAsked(),
    );

    await provider.findDogParks(59.33, 18.06, 3_000);

    expect(store.entries.size).toBe(1);
    const [key] = [...store.entries.keys()];
    // The url is part of the key, so a loader pointed somewhere new can
    // never be answered with this file's copy.
    expect(key).toContain(DEFAULT_DATASET_URL);
    expect(store.entries.get(key)).toEqual(stockholmDataset());
  });

  it("answers from the stored copy without waiting for the network", async () => {
    const store = fakeStore();
    await withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store,
      }),
      liveNeverAsked(),
    ).findDogParks(59.33, 18.06, 3_000);

    // A later session on the same store: the network never answers at all.
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: () => new Promise<Response>(() => undefined),
        store,
      }),
      liveNeverAsked(),
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([NEARBY_PARK]);
  });

  it("serves background-refreshed data to later lookups", async () => {
    const store = fakeStore();
    await withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store,
      }),
      liveNeverAsked(),
    ).findDogParks(59.33, 18.06, 3_000);

    // This week's pipeline run found a new park.
    const fresh = {
      ...stockholmDataset(),
      spots: [...stockholmDataset().spots, NEW_PARK],
    };
    const provider = withOfflineDataset(
      createDatasetLoader({ fetchImpl: respondingWith(fresh), store }),
      liveNeverAsked(),
    );

    const before = await provider.findDogParks(59.33, 18.06, 3_000);
    await afterBackgroundWork();
    const after = await provider.findDogParks(59.33, 18.06, 3_000);

    // First paint came from the week-old copy; the refresh caught up behind
    // it, in memory and in the store.
    expect(before.map((spot) => spot.id)).not.toContain(NEW_PARK.id);
    expect(after.map((spot) => spot.id)).toContain(NEW_PARK.id);
    const stored = [...store.entries.values()][0] as Dataset;
    expect(stored.spots.map((spot) => spot.id)).toContain(NEW_PARK.id);
  });

  it("keeps the good stored copy when a refresh answers a schema it cannot read", async () => {
    const store = fakeStore();
    await withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store,
      }),
      liveNeverAsked(),
    ).findDogParks(59.33, 18.06, 3_000);

    let refreshes = 0;
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: () => {
          refreshes += 1;
          return Promise.resolve(
            new Response(JSON.stringify({ ...stockholmDataset(), schema: 2 })),
          );
        },
        store,
      }),
      liveNeverAsked(),
    );

    const first = await provider.findDogParks(59.33, 18.06, 3_000);
    await afterBackgroundWork();
    const second = await provider.findDogParks(59.33, 18.06, 3_000);

    // The refresh ran and was refused: validation happens before the write,
    // so a future-schema download cannot clobber a copy this build can read.
    expect(first).toEqual([NEARBY_PARK]);
    expect(refreshes).toBe(1);
    const stored = [...store.entries.values()][0] as Dataset;
    expect(stored.schema).toBe(DATASET_SCHEMA_VERSION);
    expect(second).toEqual([NEARBY_PARK]);
  });

  it("still answers from the network when storage is denied", async () => {
    const provider = withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        // What private browsing or a full quota looks like.
        store: {
          get: () => Promise.reject(new DOMException("no access")),
          set: () =>
            Promise.reject(
              new DOMException("Quota exceeded", "QuotaExceededError"),
            ),
        },
      }),
      liveNeverAsked(),
    );

    const spots = await provider.findDogParks(59.33, 18.06, 3_000);

    expect(spots).toEqual([NEARBY_PARK]);
  });
});

describe("asking the network no more than it must", () => {
  it("shares one fetch between concurrent lookups", async () => {
    let calls = 0;
    const counting: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(stockholmDataset())));
    };
    const provider = withOfflineDataset(
      createDatasetLoader({ fetchImpl: counting, store: fakeStore() }),
      liveNeverAsked(),
    );

    const [parks, bathing] = await Promise.all([
      provider.findDogParks(59.33, 18.06, 3_000),
      provider.findBathingSpots(59.33, 18.06, 3_000),
    ]);

    expect(calls).toBe(1);
    expect(parks).toEqual([NEARBY_PARK]);
    expect(bathing).toEqual([NEARBY_BATHING, SEASONAL_BATHING]);
  });

  it("asks the network once for a whole session served from the stored copy", async () => {
    const store = fakeStore();
    await withOfflineDataset(
      createDatasetLoader({
        fetchImpl: respondingWith(stockholmDataset()),
        store,
      }),
      liveNeverAsked(),
    ).findDogParks(59.33, 18.06, 3_000);

    let calls = 0;
    const counting: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(stockholmDataset())));
    };
    const provider = withOfflineDataset(
      createDatasetLoader({ fetchImpl: counting, store }),
      liveNeverAsked(),
    );

    await provider.findDogParks(59.33, 18.06, 3_000);
    await afterBackgroundWork();
    await provider.findDogParks(59.33, 18.06, 10_000);
    await afterBackgroundWork();

    // One stale-while-revalidate refresh per session, not one per lookup.
    expect(calls).toBe(1);
  });
});
