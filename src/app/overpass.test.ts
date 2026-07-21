import {
  DEFAULT_OVERPASS_ENDPOINT,
  OVERPASS_CLIENT_TIMEOUT_MS,
  OVERPASS_MIRROR_ENDPOINT,
  createOverpassProvider,
} from "./overpass";
import { PlaceProviderError } from "./place-provider";
import capturedStockholmResponse from "./overpass.fixture.json";

/**
 * A `fetch` that always answers 200 with this payload as JSON.
 *
 * Every test injects one of these: the provider must never touch the network,
 * and the interesting cases (an HTML error page, a truncated result) are ones
 * the real service will not produce on demand anyway.
 */
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

describe("the Overpass query", () => {
  it("asks for dog parks around the requested position", async () => {
    let postedBody = "";
    const provider = createOverpassProvider({
      fetchImpl: (_url, init) => {
        postedBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(new Response(JSON.stringify({ elements: [] })));
      },
    });

    await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(new URLSearchParams(postedBody).get("data")).toBe(
      '[out:json][timeout:25];\nnwr["leisure"="dog_park"](around:3000,59.3293000,18.0686000);\nout center;',
    );
  });

  it("escapes the query instead of pasting it into the body", async () => {
    let postedBody = "";
    const provider = createOverpassProvider({
      fetchImpl: (_url, init) => {
        postedBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(new Response(JSON.stringify({ elements: [] })));
      },
    });

    await provider.findDogParks(59.3293, 18.0686, 3000);

    // Unescaped, the query's own `[`, `"` and `=` would corrupt the form.
    expect(postedBody.startsWith("data=%5Bout%3Ajson%5D")).toBe(true);
  });

  it("posts it as an HTML form, which is what Overpass accepts", async () => {
    let method = "";
    let headers: HeadersInit | undefined;
    const provider = createOverpassProvider({
      fetchImpl: (_url, init) => {
        method = init?.method ?? "";
        headers = init?.headers;
        return Promise.resolve(new Response(JSON.stringify({ elements: [] })));
      },
    });

    await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(method).toBe("POST");
    expect(new Headers(headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("goes to the main Overpass instance unless told otherwise", async () => {
    let endpoint = "";
    const provider = createOverpassProvider({
      fetchImpl: (url) => {
        endpoint = typeof url === "string" ? url : "";
        return Promise.resolve(new Response(JSON.stringify({ elements: [] })));
      },
    });

    await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(endpoint).toBe(DEFAULT_OVERPASS_ENDPOINT);
  });

  it("goes to a mirror when one is configured", async () => {
    let endpoint = "";
    const provider = createOverpassProvider({
      endpoint: OVERPASS_MIRROR_ENDPOINT,
      fetchImpl: (url) => {
        endpoint = typeof url === "string" ? url : "";
        return Promise.resolve(new Response(JSON.stringify({ elements: [] })));
      },
    });

    await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(endpoint).toBe(OVERPASS_MIRROR_ENDPOINT);
  });
});

describe("reading a captured Overpass response", () => {
  it("takes a node's position from the node itself", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(spots.find((spot) => spot.id === "node/13245355311")).toMatchObject({
      name: "Monteliusvägens hundrastgård",
      lat: 59.3207873,
      lon: 18.0596507,
    });
  });

  it("takes a way's position from the centre Overpass computed for it", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(spots.find((spot) => spot.id === "way/58082448")).toMatchObject({
      name: "Björns Trädgårds hundrastgård",
      lat: 59.3156731,
      lon: 18.0736705,
    });
  });

  it("takes a relation's position from its centre too", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(spots.find((spot) => spot.id === "relation/3181480")).toMatchObject({
      name: "Ormholmen Hundön - Drottningholm",
      lat: 59.322249,
      lon: 17.8764142,
    });
  });

  it("drops a feature Overpass could not place on the map", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    // way/485519155 in the fixture has neither lat/lon nor center. A spot at
    // (0, 0) or NaN would be worse than no spot at all.
    expect(spots.map((spot) => spot.id)).not.toContain("way/485519155");
  });

  it("drops a feature whose coordinates are not numbers", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "way",
            id: 12,
            center: { lat: 59.3, lon: null },
            tags: { leisure: "dog_park", name: "Half a position" },
          },
        ],
      }),
    });

    const spots = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spots).toEqual([]);
  });

  it("returns a feature once even when the query matched it twice", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(spots.filter((spot) => spot.id === "way/58082448")).toHaveLength(1);
  });

  it("leaves the name out when the feature has none", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    const unnamed = spots.find((spot) => spot.id === "relation/16078225");
    expect(unnamed?.name).toBeUndefined();
  });

  it("reports every result as a place designated for dogs", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith(capturedStockholmResponse),
    });

    const spots = await provider.findDogParks(59.3293, 18.0686, 3000);

    expect(spots.length).toBeGreaterThan(0);
    for (const spot of spots) {
      expect(spot.kind).toBe("dog_park");
      expect(spot.provenance).toBe("designated");
    }
  });

  it("finds nothing to complain about in a sparsely mapped region", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        version: 0.6,
        generator: "Overpass API 0.7.62.11 87bfad18",
        elements: [],
      }),
    });

    const spots = await provider.findDogParks(-3.4653, -62.2159, 3000);

    expect(spots).toEqual([]);
  });
});

describe("reading the tags of a dog park", () => {
  it("says fenced when the park is tagged fenced=yes", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 1,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park", fenced: "yes" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.fenced).toBe(true);
  });

  it("says fenced when the outline is tagged barrier=fence", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "way",
            id: 2,
            center: { lat: 59.3, lon: 18.1 },
            tags: { leisure: "dog_park", barrier: "fence" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.fenced).toBe(true);
  });

  it("says not fenced when the park is tagged fenced=no", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 3,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park", fenced: "no" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.fenced).toBe(false);
  });

  it("says not fenced when the outline is tagged barrier=no", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "relation",
            id: 4,
            center: { lat: 59.3, lon: 18.1 },
            tags: { leisure: "dog_park", barrier: "no" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.fenced).toBe(false);
  });

  it("says nothing about fencing when OSM does not", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 5,
            lat: 59.3,
            lon: 18.1,
            // A bare fence_type, which happens in Stockholm, is not a claim
            // that the park is enclosed.
            tags: { leisure: "dog_park", fence_type: "chain_link" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.fenced).toBeUndefined();
  });

  it("says lit when the park is tagged lit=yes", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 6,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park", lit: "yes" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.lit).toBe(true);
  });

  it("says lit for a lighting schedule, which still means there are lamps", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 7,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park", lit: "sunset-sunrise" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.lit).toBe(true);
  });

  it("says not lit only when the park is tagged lit=no", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 8,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park", lit: "no" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.lit).toBe(false);
  });

  it("passes the surface through as OSM wrote it", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "way",
            id: 9,
            center: { lat: 59.3, lon: 18.1 },
            tags: { leisure: "dog_park", surface: "fine_gravel" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags.surface).toBe("fine_gravel");
  });

  it("says nothing at all about an untagged park", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        elements: [
          {
            type: "node",
            id: 10,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park" },
          },
        ],
      }),
    });

    const [spot] = await provider.findDogParks(59.3, 18.1, 3000);

    expect(spot.tags).toEqual({});
  });
});

describe("when the lookup fails", () => {
  it("reports the device being offline as an unreachable network", async () => {
    const provider = createOverpassProvider({
      fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("network-unavailable");
    expect(failure.retryable).toBe(true);
  });

  it("gives up on an Overpass that never answers", async () => {
    vi.useFakeTimers();
    try {
      const provider = createOverpassProvider({
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      });

      const failing = failureFrom(provider.findDogParks(59.3, 18.1, 3000));
      await vi.advanceTimersByTimeAsync(OVERPASS_CLIENT_TIMEOUT_MS);
      const failure = await failing;

      expect(failure.kind).toBe("timeout");
      expect(failure.retryable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports being told to slow down, and for how long", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("rate-limited");
    expect(failure.retryAfterMs).toBe(30_000);
  });

  it("understands a Retry-After given as a date", async () => {
    const inOneMinute = new Date(Date.now() + 60_000).toUTCString();
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": inOneMinute },
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.retryAfterMs).toBeGreaterThan(55_000);
    expect(failure.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("ignores a Retry-After it cannot make sense of", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "soon" },
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    // No hint at all beats a NaN in the caller's backoff arithmetic.
    expect(failure.retryAfterMs).toBeUndefined();
  });

  it("still reports rate limiting when no wait was suggested", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Too Many Requests", { status: 429 }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("rate-limited");
    expect(failure.retryAfterMs).toBeUndefined();
  });

  it("treats a 504 as Overpass having no free slot, not a broken gateway", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Gateway Timeout", { status: 504 }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("rate-limited");
    expect(failure.retryable).toBe(true);
  });

  it("reports a server fault with its status", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("Internal Server Error", { status: 500 }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("http-error");
    expect(failure.status).toBe(500);
  });

  it("reports the HTML page Overpass sends when it rejects the request", async () => {
    // overpass-api.de answers a request with a blank User-Agent this way.
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw(
        "<html><body><p>Error: Not Acceptable</p></body></html>",
        { status: 406, headers: { "Content-Type": "text/html" } },
      ),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("http-error");
    expect(failure.status).toBe(406);
    // Nothing the user can do, and the same request would fail identically.
    expect(failure.retryable).toBe(false);
  });

  it("refuses a 200 that is not JSON at all", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingRaw("<html><body>Service moved</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("malformed-response");
  });

  it("refuses JSON that is not an Overpass answer", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({ error: "unauthorized" }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("malformed-response");
  });

  it("refuses a truncated result rather than passing off part of it as all of it", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        version: 0.6,
        generator: "Overpass API 0.7.62.11 87bfad18",
        remark: "runtime error: Query run out of memory using about 2048 MB",
        elements: [
          {
            type: "node",
            id: 11,
            lat: 59.3,
            lon: 18.1,
            tags: { leisure: "dog_park" },
          },
        ],
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("malformed-response");
  });

  it("treats Overpass giving up on the query as the timeout it is", async () => {
    const provider = createOverpassProvider({
      fetchImpl: respondingWith({
        version: 0.6,
        generator: "Overpass API 0.7.62.11 87bfad18",
        remark:
          'runtime error: Query timed out in "recurse" at line 3 after 25 seconds.',
        elements: [],
      }),
    });

    const failure = await failureFrom(provider.findDogParks(59.3, 18.1, 3000));

    expect(failure.kind).toBe("timeout");
    expect(failure.retryable).toBe(true);
  });
});
