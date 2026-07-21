import { buildSearchUrl, createRateGate, searchPlaces } from "./nominatim";

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response;
}

/**
 * Most of these tests are about parsing, not fair use, so they step past the
 * shared rate gate. Tests that care about the gate build their own.
 */
const noWait = () => Promise.resolve();

describe("buildSearchUrl", () => {
  it("asks Nominatim for a handful of matches in a parseable format", () => {
    expect(buildSearchUrl("Stockholm")).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=Stockholm",
    );
  });

  it("encodes spaces and Swedish characters so the query survives the trip", () => {
    expect(buildSearchUrl("Södermalm, Sverige")).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=S%C3%B6dermalm%2C+Sverige",
    );
  });
});

describe("searchPlaces", () => {
  it("reports each match as a label and a position", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          display_name: "Södermalm, Stockholm, Sverige",
          lat: "59.3120",
          lon: "18.0700",
        },
      ]),
    );

    const matches = await searchPlaces("Södermalm", { fetchFn, gate: noWait });

    expect(matches).toEqual([
      {
        label: "Södermalm, Stockholm, Sverige",
        position: { lat: 59.312, lon: 18.07 },
      },
    ]);
  });

  it("returns nothing when the place name matches nothing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([]));

    const matches = await searchPlaces("qwertyuiop", { fetchFn, gate: noWait });

    expect(matches).toEqual([]);
  });

  it("drops a hit with no name, since there would be nothing to tap", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        { display_name: "Vasaparken, Stockholm", lat: "59.34", lon: "18.05" },
        { lat: "59.35", lon: "18.06" },
      ]),
    );

    const matches = await searchPlaces("park", { fetchFn, gate: noWait });

    expect(matches.map((match) => match.label)).toEqual([
      "Vasaparken, Stockholm",
    ]);
  });

  it("drops a hit whose coordinates are unusable rather than stranding it at Null Island", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse([
        { display_name: "Blank coordinates", lat: "", lon: "" },
        { display_name: "Nonsense coordinates", lat: "north-ish", lon: "18.0" },
        { display_name: "Real place", lat: "59.33", lon: "18.07" },
      ]),
    );

    const matches = await searchPlaces("anything", { fetchFn, gate: noWait });

    expect(matches).toEqual([
      { label: "Real place", position: { lat: 59.33, lon: 18.07 } },
    ]);
  });

  it("fails loudly when Nominatim turns the request away", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(
      searchPlaces("too eager", { fetchFn, gate: noWait }),
    ).rejects.toThrow("429");
  });

  it("fails loudly when the network is down", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      searchPlaces("anywhere", { fetchFn, gate: noWait }),
    ).rejects.toThrow("offline");
  });

  it("waits for the fair-use gate before touching the network", async () => {
    let openGate = () => {};
    const gate = () =>
      new Promise<void>((resolve) => {
        openGate = resolve;
      });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([]));

    const pending = searchPlaces("Stockholm", { fetchFn, gate });
    await Promise.resolve();
    expect(fetchFn).not.toHaveBeenCalled();

    openGate();
    await pending;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("createRateGate", () => {
  /**
   * A clock we advance by hand, so a one-second limit costs no real second.
   * Sleeping records how long was asked for but does not move the clock —
   * time passes only when a test says so, which is what lets several callers
   * be observed racing at the same instant.
   */
  function fakeClock() {
    let time = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => time,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      passTime: (ms: number) => {
        time += ms;
      },
    };
  }

  it("lets the first caller straight through", async () => {
    const clock = fakeClock();
    const gate = createRateGate(1000, clock.now, clock.sleep);

    await gate();

    expect(clock.sleeps).toEqual([]);
  });

  it("holds a caller that arrives too soon until the interval is up", async () => {
    const clock = fakeClock();
    const gate = createRateGate(1000, clock.now, clock.sleep);

    await gate();
    clock.passTime(200);
    await gate();

    expect(clock.sleeps).toEqual([800]);
  });

  it("does not delay a caller that already waited long enough", async () => {
    const clock = fakeClock();
    const gate = createRateGate(1000, clock.now, clock.sleep);

    await gate();
    clock.passTime(5000);
    await gate();

    expect(clock.sleeps).toEqual([]);
  });

  it("spaces out a burst of simultaneous callers one interval apart", async () => {
    const clock = fakeClock();
    const gate = createRateGate(1000, clock.now, clock.sleep);

    await Promise.all([gate(), gate(), gate()]);

    // First goes now, second after a second, third after two — nobody sees an
    // all-clear that a queued caller has already claimed.
    expect(clock.sleeps).toEqual([1000, 2000]);
  });
});
