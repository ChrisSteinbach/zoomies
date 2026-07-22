// @vitest-environment jsdom
//
// The wiring, end to end, with the network and the GPS replaced and everything
// else real: the actual state machine, the actual views, the actual Leaflet.
// The point is to catch the faults that only exist between correct parts — an
// event nobody dispatches, a view nobody re-renders, a stale answer landing on
// top of a fresh one.
//
// jsdom lays nothing out, so nothing here asserts on geometry.

import { composeApp } from "./compose-app";
import type { AppDeps } from "./compose-app";
import type { ExpandingSearchResult } from "./expanding-search";
import type { LocationCallbacks, StopFn } from "./location";
import { loadMarks, resetLoadTimeline } from "./load-timeline";
import { PlaceProviderError } from "./place-provider";
import type { DogSpot, LatLon } from "./types";

const TANTOLUNDEN: LatLon = { lat: 59.3123, lon: 18.0421 };
/** ~1.1 km north — far enough to make the app query again. */
const FAR_ENOUGH: LatLon = { lat: 59.3223, lon: 18.0421 };

function spot(id: string, name: string, lat: number): DogSpot {
  return {
    id,
    kind: "dog_park",
    name,
    lat,
    lon: 18.0421,
    tags: {},
    provenance: "designated",
  };
}

const TANTO = spot("way/1", "Tantolundens hundrastgård", 59.3133);
const DRAKEN = spot("way/2", "Drakenbergsparkens hundrastgård", 59.3223);

/** A geolocation we drive by hand. */
function fakeGps() {
  let callbacks: LocationCallbacks | undefined;
  const stop = vi.fn();

  const watch = (given: LocationCallbacks): StopFn => {
    callbacks = given;
    return stop;
  };

  return {
    watch,
    stop,
    fix(position: LatLon, accuracyM: number | null = null) {
      callbacks?.onPosition(position, accuracyM);
    },
    fail(code: "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT") {
      callbacks?.onError({ code, message: code });
    },
  };
}

/** A search we resolve by hand, so ordering is ours to control. */
function fakeSearch() {
  const pending: {
    resolve: (result: ExpandingSearchResult) => void;
    reject: (error: unknown) => void;
  }[] = [];

  const search = () =>
    new Promise<ExpandingSearchResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });

  return {
    search,
    get calls() {
      return pending.length;
    },
    async answer(spots: DogSpot[], radiusM = 3000, which = pending.length - 1) {
      pending[which].resolve({ spots, radiusM });
      await flush();
    },
    async fail(error: unknown, which = pending.length - 1) {
      pending[which].reject(error);
      await flush();
    },
  };
}

/** Let the dispatch that a settled promise triggers actually run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A picker we drive by hand.
 *
 * Picking a spot is pixel arithmetic against a laid-out map, which jsdom
 * cannot do — map-picker.test.ts covers that path. What belongs here is only
 * what the app does once a position comes back.
 */
function fakePicker() {
  let onPick: ((position: LatLon) => void) | undefined;
  let onCancel: (() => void) | undefined;
  const destroy = vi.fn();

  return {
    destroy,
    create: (
      _container: HTMLElement,
      options: { onPick: (p: LatLon) => void; onCancel?: () => void },
    ) => {
      onPick = options.onPick;
      onCancel = options.onCancel;
      return { destroy };
    },
    pick(position: LatLon) {
      onPick?.(position);
    },
    cancel() {
      onCancel?.();
    },
    get isOpen() {
      return onPick !== undefined;
    },
  };
}

function mount(deps: Partial<AppDeps> = {}) {
  const gps = fakeGps();
  const search = fakeSearch();
  const bathingSearch = fakeSearch();
  const picker = fakePicker();
  const openUrl = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);

  const app = composeApp(root, {
    watch: gps.watch,
    search: search.search,
    bathingSearch: bathingSearch.search,
    createPicker: picker.create,
    openUrl,
    ...deps,
  });

  return { app, root, gps, search, bathingSearch, picker, openUrl };
}

function parkNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".spot-list-item")].map((row) => {
    const name = row
      .querySelector(".spot-list-name")!
      .cloneNode(true) as HTMLElement;
    // A bathing row's "Bathing" badge sits inside the name so that it wraps
    // with the words rather than taking a column off them (spot-list.ts). It
    // is a marker on the row, not part of what the place is called.
    name.querySelector(".spot-list-kind")?.remove();
    return name.textContent.trim();
  });
}

function statusText(root: HTMLElement): string {
  return root.querySelector(".app-status")?.textContent?.trim() ?? "";
}

beforeEach(() => {
  // The timeline is one cold start's worth of module state (load-timeline.ts),
  // not something scoped to a test — without this, only the first test in the
  // file would ever get to record a "watch-started", since a milestone's
  // first write wins.
  resetLoadTimeline();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("opening the app", () => {
  it("starts looking for the user straight away", () => {
    const { root, search } = mount();

    expect(statusText(root)).toMatch(/location/i);
    expect(search.calls).toBe(0);
  });

  it("searches from the first fix and lists what it finds", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([DRAKEN, TANTO]);

    expect(parkNames(root)).toEqual([
      "Tantolundens hundrastgård",
      "Drakenbergsparkens hundrastgård",
    ]);
  });

  it("credits OpenStreetMap before it has found anything at all", () => {
    const { root } = mount();

    expect(root.textContent).toContain("OpenStreetMap");
  });
});

describe("when the device will not say where the user is", () => {
  it("offers the manual picker and stops asking", () => {
    const { root, gps } = mount();

    gps.fail("PERMISSION_DENIED");

    expect(root.querySelector(".app-status button")?.textContent).toMatch(
      /position/i,
    );
    expect(gps.stop).toHaveBeenCalled();
  });

  it("searches from a position the user picks instead", async () => {
    const { root, gps, search, picker } = mount();

    gps.fail("PERMISSION_DENIED");
    root.querySelector<HTMLButtonElement>(".status-action-primary")!.click();
    picker.pick(TANTOLUNDEN);
    await search.answer([TANTO]);

    expect(parkNames(root)).toEqual(["Tantolundens hundrastgård"]);
  });

  it("puts the picker away once a position has come back from it", async () => {
    const { root, gps, search, picker } = mount();

    gps.fail("PERMISSION_DENIED");
    root.querySelector<HTMLButtonElement>(".status-action-primary")!.click();
    picker.pick(TANTOLUNDEN);
    await search.answer([TANTO]);

    expect(picker.destroy).toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>(".app-picker")!.hidden).toBe(true);
  });
});

describe("cancelling the picker", () => {
  it("puts the previous results back when the user backs out without picking", async () => {
    const { root, gps, search, picker } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO, DRAKEN]);
    gps.fix(FAR_ENOUGH);
    // Not retryable, so the only action offered is the picker — opened here
    // over the stale results the failed refresh left on screen.
    await search.fail(
      new PlaceProviderError("malformed-response", "could not read that"),
    );
    root.querySelector<HTMLButtonElement>(".status-action-primary")!.click();

    expect(picker.isOpen).toBe(true);
    expect(root.querySelector<HTMLElement>(".app-picker")!.hidden).toBe(false);

    picker.cancel();

    expect(picker.destroy).toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>(".app-picker")!.hidden).toBe(true);
    expect(statusText(root)).toMatch(/out of date/i);
    // Sorted by distance from where the user is now (FAR_ENOUGH), not from
    // where the original search ran.
    expect(parkNames(root)).toEqual([
      "Drakenbergsparkens hundrastgård",
      "Tantolundens hundrastgård",
    ]);
  });
});

describe("while the user walks", () => {
  it("keeps the results and re-measures for a small step", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO, DRAKEN]);
    gps.fix({ lat: 59.3128, lon: 18.0421 });

    expect(search.calls).toBe(1);
    expect(parkNames(root)).toHaveLength(2);
  });

  it("queries again once they have gone somewhere", async () => {
    const { gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    gps.fix(FAR_ENOUGH);

    expect(search.calls).toBe(2);
  });

  it("ignores an answer to a question the user has already walked away from", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    gps.fix(FAR_ENOUGH);

    // The second query is in flight; the first one answers late.
    await search.answer([DRAKEN, TANTO], 3000, 0);

    expect(parkNames(root)).toEqual(["Tantolundens hundrastgård"]);
  });
});

describe("when the lookup fails", () => {
  it("warns that the results are stale rather than blanking them", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO, DRAKEN]);
    gps.fix(FAR_ENOUGH);
    await search.fail(new PlaceProviderError("timeout", "took too long"));

    expect(statusText(root)).toMatch(/out of date/i);
    expect(parkNames(root)).toHaveLength(2);
  });

  it("takes the screen over when the very first search is the one that failed", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.fail(new PlaceProviderError("timeout", "took too long"));

    expect(root.dataset.presence).toBe("takeover");
    expect(statusText(root)).toMatch(/too long/i);
  });

  it("searches again when the user asks it to", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.fail(new PlaceProviderError("timeout", "took too long"));
    root.querySelector<HTMLButtonElement>(".status-action-primary")!.click();

    expect(search.calls).toBe(2);
  });

  it("reports an unexpected throw as an answer it could not read", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.fail(new TypeError("spots.map is not a function"));

    expect(statusText(root)).toMatch(/could not read|made no sense/i);
  });
});

describe("finding nothing", () => {
  it("says how far it looked, and does not call it an error", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([], 25_000);

    expect(statusText(root)).toContain("25 km");
    expect(parkNames(root)).toEqual([]);
  });

  it("does not fall back to the parks it found in the last place", async () => {
    const { root, gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO, DRAKEN]);
    gps.fix(FAR_ENOUGH);
    await search.answer([], 25_000);

    expect(parkNames(root)).toEqual([]);
  });
});

describe("acting on a result", () => {
  it("hands the park off to the maps app", async () => {
    const { root, gps, search, openUrl } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    root.querySelector<HTMLButtonElement>(".spot-list-directions")!.click();

    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining(`${TANTO.lat},${TANTO.lon}`),
    );
  });

  it("leaves the origin to the maps app when the GPS knows where we are", async () => {
    const { root, gps, search, openUrl } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    root.querySelector<HTMLButtonElement>(".spot-list-directions")!.click();

    expect(openUrl).toHaveBeenCalledWith(expect.not.stringContaining("origin"));
  });
});

const HUNDBADET: DogSpot = {
  id: "way/9",
  kind: "bathing_spot",
  name: "Smedsuddsbadets hundbad",
  lat: 59.3153,
  lon: 18.0421,
  tags: {},
  provenance: "permitted",
};

function bathingChip(root: HTMLElement): HTMLButtonElement {
  const chip = root.querySelector<HTMLButtonElement>(".layer-toggle-chip");
  if (!chip) throw new Error("the layer chip should be in the drawer");
  return chip;
}

describe("the bathing layer, wired", () => {
  it("searches when toggled on and folds what it finds into the one list", async () => {
    const { root, gps, search, bathingSearch } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    expect(bathingSearch.calls).toBe(0);

    bathingChip(root).click();
    expect(bathingSearch.calls).toBe(1);
    await bathingSearch.answer([HUNDBADET], 10_000);

    // One list with distance deciding the order across layers: the park at
    // ~110 m, then the hundbad at ~330 m — not parks first, then bathing.
    expect(parkNames(root)).toEqual([
      "Tantolundens hundrastgård",
      "Smedsuddsbadets hundbad",
    ]);
  });

  it("takes the bathing rows back out when toggled off", async () => {
    const { root, gps, search, bathingSearch } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    bathingChip(root).click();
    await bathingSearch.answer([HUNDBADET], 10_000);

    bathingChip(root).click();

    expect(parkNames(root)).toEqual(["Tantolundens hundrastgård"]);
  });

  it("offers a retry when the layer fails, which asks again", async () => {
    const { root, gps, search, bathingSearch } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    bathingChip(root).click();
    await bathingSearch.fail(new PlaceProviderError("busy", "no free slot"));

    expect(root.textContent).toContain("Couldn’t load bathing spots.");

    root.querySelector<HTMLButtonElement>(".layer-toggle-retry")!.click();
    expect(bathingSearch.calls).toBe(2);
  });

  it("shows a place found by both layers once, as the park", async () => {
    const { root, gps, search, bathingSearch } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    bathingChip(root).click();
    // The same OSM element, re-found by the bathing layer's name regex —
    // real Stockholm dog parks are named "… Hundbad" and match it.
    await bathingSearch.answer(
      [{ ...HUNDBADET, id: TANTO.id, name: TANTO.name }],
      10_000,
    );

    expect(parkNames(root)).toEqual(["Tantolundens hundrastgård"]);
    expect(root.querySelectorAll(".spot-list-kind")).toHaveLength(0);
  });

  it("hands a hundbad to the maps app even when no parks were found", async () => {
    const { root, gps, search, bathingSearch, openUrl } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([], 25_000);
    bathingChip(root).click();
    await bathingSearch.answer([HUNDBADET], 10_000);

    root.querySelector<HTMLButtonElement>(".spot-list-directions")!.click();

    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining(`${HUNDBADET.lat},${HUNDBADET.lon}`),
    );
  });
});

describe("shutting down", () => {
  it("stops following the user and leaves nothing behind", () => {
    const { app, root, gps } = mount();

    gps.fix(TANTOLUNDEN);
    app.destroy();

    expect(gps.stop).toHaveBeenCalled();
    expect(root.children).toHaveLength(0);
  });

  it("closes the picker if it is still open", () => {
    const { app, root, gps, picker } = mount();

    gps.fail("PERMISSION_DENIED");
    root.querySelector<HTMLButtonElement>(".status-action-primary")!.click();
    app.destroy();

    expect(picker.destroy).toHaveBeenCalled();
  });
});

describe("the load timeline", () => {
  it("marks its way from asking for a position to the first row on screen", async () => {
    const { gps, search } = mount();

    gps.fix(TANTOLUNDEN, 8);
    await search.answer([TANTO]);

    expect(loadMarks().map((mark) => mark.milestone)).toEqual([
      "watch-started",
      "first-fix",
      "search-started",
      "search-settled",
      "first-row",
    ]);
  });

  it("notes how far out the fix was", () => {
    const { gps } = mount();

    gps.fix(TANTOLUNDEN, 8);

    const fix = loadMarks().find((mark) => mark.milestone === "first-fix");
    expect(fix?.detail).toBe("±8 m");
  });

  it("does not claim a first row when the search comes back empty", async () => {
    const { gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([], 25_000);

    expect(loadMarks().map((mark) => mark.milestone)).not.toContain(
      "first-row",
    );
  });

  it("marks the search as settled even for an answer nobody is waiting for any more", async () => {
    const { gps, search } = mount();

    gps.fix(TANTOLUNDEN);
    await search.answer([TANTO]);
    gps.fix(FAR_ENOUGH);
    await search.answer([DRAKEN], 3000, 0);

    // Both the live search and the one the user has since walked away from
    // are "data back" moments; only the first is a record of the cold start,
    // per markLoad's first-write-wins rule.
    expect(
      loadMarks().filter((mark) => mark.milestone === "search-settled"),
    ).toHaveLength(1);
  });
});
