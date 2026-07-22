import { initialState, transition } from "./state-machine";
import type { AppState, Effect, Event, Phase } from "./state-machine";
import { PlaceProviderError } from "./place-provider";
import type { DogSpot, LatLon } from "./types";

const TANTOLUNDEN: LatLon = { lat: 59.3123, lon: 18.0421 };
/** ~111 m north — ordinary GPS drift, well inside the re-query threshold. */
const A_FEW_STEPS: LatLon = { lat: 59.3133, lon: 18.0421 };
/** ~555 m north — a real walk. */
const A_WALK_AWAY: LatLon = { lat: 59.3173, lon: 18.0421 };

function spot(id: string, name?: string): DogSpot {
  return {
    id,
    kind: "dog_park",
    ...(name === undefined ? {} : { name }),
    lat: 59.3123,
    lon: 18.0421,
    tags: {},
    provenance: "designated",
  };
}

const TANTO = spot("way/1", "Tantolundens hundrastgård");
const DRAKEN = spot("way/2", "Drakenbergsparkens hundrastgård");

/** Drive the machine through a sequence, returning the last result. */
function run(events: Event[], from: AppState = initialState) {
  let state = from;
  let effects: Effect[] = [];
  for (const event of events) {
    const result = transition(state, event);
    state = result.next;
    effects = result.effects;
  }
  return { state, effects };
}

const showingResults: Event[] = [
  { kind: "position-fixed", position: TANTOLUNDEN },
  { kind: "search-succeeded", spots: [TANTO, DRAKEN], searchedRadiusM: 3000 },
];

describe("finding the user", () => {
  it("starts watching the GPS as soon as the app opens", () => {
    const { effects } = run([{ kind: "started" }]);

    expect(effects).toEqual([{ kind: "watch-location" }]);
  });

  it("searches as soon as it knows where the user is", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "position-fixed", position: TANTOLUNDEN },
    ]);

    expect(state.phase.kind).toBe("searching");
    expect(effects).toEqual([{ kind: "search", position: TANTOLUNDEN }]);
  });

  it("offers the manual picker when the user refuses the permission", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "location-failed", reason: "PERMISSION_DENIED" },
    ]);

    expect(state.phase).toEqual({
      kind: "needs-position",
      reason: "PERMISSION_DENIED",
    });
    expect(effects).toContainEqual({ kind: "stop-watching" });
  });

  it("does not throw the user out of their results when a later fix fails", () => {
    const { state } = run([
      ...showingResults,
      { kind: "location-failed", reason: "POSITION_UNAVAILABLE" },
    ]);

    expect(state.phase.kind).toBe("ready");
  });
});

describe("picking a position by hand", () => {
  it("opens over the results rather than replacing them", () => {
    const { state } = run([...showingResults, { kind: "pick-requested" }]);

    expect(state.pickerOpen).toBe(true);
    expect(state.phase.kind).toBe("ready");
  });

  it("puts the user back where they were when they cancel", () => {
    const { state } = run([
      ...showingResults,
      { kind: "pick-requested" },
      { kind: "pick-cancelled" },
    ]);

    expect(state.pickerOpen).toBe(false);
    expect(state.phase.kind).toBe("ready");
  });

  it("searches from the picked spot and stops following the GPS", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "location-failed", reason: "PERMISSION_DENIED" },
      { kind: "pick-requested" },
      { kind: "position-picked", position: TANTOLUNDEN },
    ]);

    expect(state.positionSource).toBe("picked");
    expect(state.pickerOpen).toBe(false);
    expect(effects).toContainEqual({ kind: "stop-watching" });
    expect(effects).toContainEqual({
      kind: "search",
      position: TANTOLUNDEN,
    });
  });

  it("does not let a late GPS fix overrule a position the user chose", () => {
    const { state, effects } = run([
      { kind: "position-picked", position: TANTOLUNDEN },
      { kind: "search-succeeded", spots: [TANTO], searchedRadiusM: 3000 },
      { kind: "position-fixed", position: A_WALK_AWAY },
    ]);

    expect(state.positionSource).toBe("picked");
    expect(phasePosition(state.phase)).toEqual(TANTOLUNDEN);
    expect(effects).toEqual([]);
  });
});

describe("answering the search", () => {
  it("shows what it found", () => {
    const { state } = run(showingResults);

    expect(state.phase).toMatchObject({
      kind: "ready",
      spots: [TANTO, DRAKEN],
      searchedRadiusM: 3000,
    });
    expect(state.selectedId).toBeNull();
  });

  it("says it found nothing rather than calling that an error", () => {
    const { state } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "search-succeeded", spots: [], searchedRadiusM: 25_000 },
    ]);

    expect(state.phase).toEqual({
      kind: "empty",
      position: TANTOLUNDEN,
      searchedRadiusM: 25_000,
    });
  });

  it("does not fall back to the last town's parks when this one has none", () => {
    const { state } = run([
      ...showingResults,
      { kind: "position-fixed", position: A_WALK_AWAY },
      { kind: "search-succeeded", spots: [], searchedRadiusM: 25_000 },
    ]);

    expect(state.phase.kind).toBe("empty");
  });
});

describe("when the search fails", () => {
  const timedOut = new PlaceProviderError("timeout", "Overpass gave up");

  it("keeps the last good results on screen", () => {
    const { state } = run([
      ...showingResults,
      { kind: "position-fixed", position: A_WALK_AWAY },
      { kind: "search-failed", error: timedOut },
    ]);

    expect(state.phase).toMatchObject({
      kind: "failed",
      error: timedOut,
      staleSpots: [TANTO, DRAKEN],
    });
  });

  it("has nothing stale to offer when the first search is the one that failed", () => {
    const { state } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "search-failed", error: timedOut },
    ]);

    expect(state.phase).toMatchObject({ kind: "failed", staleSpots: [] });
  });

  it("searches again from the same position when the user retries", () => {
    const { state, effects } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "search-failed", error: timedOut },
      { kind: "retry-requested" },
    ]);

    expect(state.phase.kind).toBe("searching");
    expect(effects).toEqual([{ kind: "search", position: TANTOLUNDEN }]);
  });

  it("still holds the stale results while the retry is in flight", () => {
    const { state } = run([
      ...showingResults,
      { kind: "position-fixed", position: A_WALK_AWAY },
      { kind: "search-failed", error: timedOut },
      { kind: "retry-requested" },
    ]);

    expect(state.phase).toMatchObject({
      kind: "searching",
      staleSpots: [TANTO, DRAKEN],
    });
  });

  it("asks the device again when the user retries from the dead end", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "location-failed", reason: "TIMEOUT" },
      { kind: "location-retry-requested" },
    ]);

    expect(state.phase).toEqual({ kind: "locating" });
    expect(effects).toEqual([{ kind: "watch-location" }]);
  });

  it("does not restart the watcher when it is already following the user", () => {
    const { state, effects } = run([
      ...showingResults,
      { kind: "location-retry-requested" },
    ]);

    expect(state.phase.kind).toBe("ready");
    expect(effects).toEqual([]);
  });

  it("has nothing to retry while it does not know where the user is", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "location-failed", reason: "PERMISSION_DENIED" },
      { kind: "retry-requested" },
    ]);

    expect(state.phase.kind).toBe("needs-position");
    expect(effects).toEqual([]);
  });
});

describe("following the user as they walk", () => {
  it("moves the user without re-querying for ordinary GPS drift", () => {
    const { state, effects } = run([
      ...showingResults,
      { kind: "position-fixed", position: A_FEW_STEPS },
    ]);

    expect(state.phase).toMatchObject({
      kind: "ready",
      position: A_FEW_STEPS,
      spots: [TANTO, DRAKEN],
    });
    expect(effects).toEqual([]);
  });

  it("queries again once the user has genuinely walked somewhere", () => {
    const { state, effects } = run([
      ...showingResults,
      { kind: "position-fixed", position: A_WALK_AWAY },
    ]);

    expect(state.phase.kind).toBe("searching");
    expect(effects).toEqual([{ kind: "search", position: A_WALK_AWAY }]);
  });

  it("does not fire a second query while one is already in flight", () => {
    const { state, effects } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "position-fixed", position: A_WALK_AWAY },
    ]);

    expect(state.phase).toMatchObject({
      kind: "searching",
      position: A_WALK_AWAY,
    });
    expect(effects).toEqual([]);
  });
});

describe("acting on a result", () => {
  it("remembers which result the user picked out", () => {
    const { state } = run([
      ...showingResults,
      { kind: "spot-selected", id: "way/2" },
    ]);

    expect(state.selectedId).toBe("way/2");
  });

  it("leaves the starting point to the maps app when the GPS knows it", () => {
    const { effects } = run([
      ...showingResults,
      { kind: "directions-requested", id: "way/1" },
    ]);

    expect(effects).toEqual([
      { kind: "open-directions", spot: TANTO, origin: null },
    ]);
  });

  it("routes from the picked spot when the user chose one", () => {
    const { effects } = run([
      { kind: "position-picked", position: TANTOLUNDEN },
      { kind: "search-succeeded", spots: [TANTO], searchedRadiusM: 3000 },
      { kind: "directions-requested", id: "way/1" },
    ]);

    expect(effects).toEqual([
      { kind: "open-directions", spot: TANTO, origin: TANTOLUNDEN },
    ]);
  });

  it("ignores a request for a result it does not have", () => {
    const { effects } = run([
      ...showingResults,
      { kind: "directions-requested", id: "way/999" },
    ]);

    expect(effects).toEqual([]);
  });
});

function bathingSpot(id: string, name?: string): DogSpot {
  return {
    id,
    kind: "bathing_spot",
    ...(name === undefined ? {} : { name }),
    lat: 59.3208,
    lon: 18.0284,
    tags: {},
    provenance: "permitted",
  };
}

const HUNDBADET = bathingSpot("way/9", "Smedsuddsbadets hundbad");

const bathingOn: Event[] = [...showingResults, { kind: "bathing-toggled" }];

const bathingReady: Event[] = [
  ...bathingOn,
  {
    kind: "bathing-search-succeeded",
    spots: [HUNDBADET],
    searchedRadiusM: 10_000,
  },
];

describe("the bathing layer", () => {
  it("starts looking from where the user is when toggled on", () => {
    const { state, effects } = run(bathingOn);

    expect(state.bathing).toEqual({ kind: "loading", staleSpots: [] });
    expect(effects).toEqual([
      { kind: "search-bathing", position: TANTOLUNDEN },
    ]);
  });

  it("stays off when there is nowhere to search from", () => {
    const { state, effects } = run([
      { kind: "started" },
      { kind: "bathing-toggled" },
    ]);

    expect(state.bathing).toEqual({ kind: "off" });
    expect(effects).toEqual([]);
  });

  it("shows what it found", () => {
    const { state } = run(bathingReady);

    expect(state.bathing).toEqual({
      kind: "ready",
      spots: [HUNDBADET],
      searchedRadiusM: 10_000,
    });
  });

  it("keeps an empty answer as an answer, with how far it looked", () => {
    const { state } = run([
      ...bathingOn,
      { kind: "bathing-search-succeeded", spots: [], searchedRadiusM: 25_000 },
    ]);

    expect(state.bathing).toEqual({
      kind: "ready",
      spots: [],
      searchedRadiusM: 25_000,
    });
  });

  it("discards the layer when toggled off", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "bathing-toggled" },
    ]);

    expect(state.bathing).toEqual({ kind: "off" });
    expect(effects).toEqual([]);
  });

  it("ignores an answer that lands after the layer was toggled off", () => {
    const { state } = run([
      ...bathingOn,
      { kind: "bathing-toggled" },
      {
        kind: "bathing-search-succeeded",
        spots: [HUNDBADET],
        searchedRadiusM: 10_000,
      },
    ]);

    expect(state.bathing).toEqual({ kind: "off" });
  });

  it("keeps what was on screen when a refresh fails", () => {
    const { state } = run([
      ...bathingReady,
      { kind: "position-fixed", position: A_WALK_AWAY },
      { kind: "bathing-search-failed" },
    ]);

    expect(state.bathing).toEqual({
      kind: "failed",
      staleSpots: [HUNDBADET],
    });
  });

  it("asks again when the user retries a failed layer", () => {
    const { state, effects } = run([
      ...bathingOn,
      { kind: "bathing-search-failed" },
      { kind: "bathing-retry-requested" },
    ]);

    expect(state.bathing).toEqual({ kind: "loading", staleSpots: [] });
    expect(effects).toEqual([
      { kind: "search-bathing", position: TANTOLUNDEN },
    ]);
  });

  it("refuses a layer retry when nothing failed", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "bathing-retry-requested" },
    ]);

    expect(state.bathing.kind).toBe("ready");
    expect(effects).toEqual([]);
  });

  it("follows the user when they genuinely walk somewhere", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "position-fixed", position: A_WALK_AWAY },
    ]);

    expect(state.bathing).toEqual({
      kind: "loading",
      staleSpots: [HUNDBADET],
    });
    expect(effects).toEqual([
      { kind: "search", position: A_WALK_AWAY },
      { kind: "search-bathing", position: A_WALK_AWAY },
    ]);
  });

  it("sits still through ordinary GPS drift, like the parks do", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "position-fixed", position: A_FEW_STEPS },
    ]);

    expect(state.bathing.kind).toBe("ready");
    expect(effects).toEqual([]);
  });

  it("moves with a hand-picked position", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "position-picked", position: A_WALK_AWAY },
    ]);

    expect(state.bathing).toEqual({
      kind: "loading",
      staleSpots: [HUNDBADET],
    });
    expect(effects).toContainEqual({
      kind: "search-bathing",
      position: A_WALK_AWAY,
    });
  });

  it("refreshes alongside a retried park search", () => {
    const { state, effects } = run([
      ...bathingReady,
      { kind: "position-fixed", position: A_WALK_AWAY },
      { kind: "search-failed", error: busyError() },
      { kind: "bathing-search-failed" },
      { kind: "retry-requested" },
    ]);

    expect(state.bathing.kind).toBe("loading");
    expect(effects).toEqual([
      { kind: "search", position: A_WALK_AWAY },
      { kind: "search-bathing", position: A_WALK_AWAY },
    ]);
  });
});

describe("selection across both layers", () => {
  it("lets a bathing spot be selected while the park search sits empty", () => {
    const { state } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "search-succeeded", spots: [], searchedRadiusM: 25_000 },
      { kind: "bathing-toggled" },
      {
        kind: "bathing-search-succeeded",
        spots: [HUNDBADET],
        searchedRadiusM: 10_000,
      },
      { kind: "spot-selected", id: "way/9" },
    ]);

    expect(state.phase.kind).toBe("empty");
    expect(state.selectedId).toBe("way/9");
  });

  it("gives directions to a bathing spot while the park search sits empty", () => {
    const { effects } = run([
      { kind: "position-fixed", position: TANTOLUNDEN },
      { kind: "search-succeeded", spots: [], searchedRadiusM: 25_000 },
      { kind: "bathing-toggled" },
      {
        kind: "bathing-search-succeeded",
        spots: [HUNDBADET],
        searchedRadiusM: 10_000,
      },
      { kind: "directions-requested", id: "way/9" },
    ]);

    expect(effects).toEqual([
      { kind: "open-directions", spot: HUNDBADET, origin: null },
    ]);
  });

  it("keeps the selection through a refresh that still holds the spot", () => {
    const { state } = run([
      ...showingResults,
      { kind: "spot-selected", id: "way/1" },
      { kind: "position-fixed", position: A_WALK_AWAY },
      {
        kind: "search-succeeded",
        spots: [TANTO],
        searchedRadiusM: 3000,
      },
    ]);

    expect(state.selectedId).toBe("way/1");
  });

  it("clears the selection when its spot is no longer in the answer", () => {
    const { state } = run([
      ...showingResults,
      { kind: "spot-selected", id: "way/1" },
      { kind: "position-fixed", position: A_WALK_AWAY },
      {
        kind: "search-succeeded",
        spots: [DRAKEN],
        searchedRadiusM: 3000,
      },
    ]);

    expect(state.selectedId).toBeNull();
  });

  it("clears the selection when its layer is toggled off", () => {
    const { state } = run([
      ...bathingReady,
      { kind: "spot-selected", id: "way/9" },
      { kind: "bathing-toggled" },
    ]);

    expect(state.selectedId).toBeNull();
  });

  it("treats a place found by both layers as the park it is tagged as", () => {
    // Real Stockholm data: dog parks named "… Hundbad" are caught by the
    // bathing layer's name regex too. One element, one place — and asking for
    // directions must route to the park identity, not a name-match twin.
    const bathingTwin = { ...bathingSpot("way/1", "Tanto hundbad") };
    const { effects } = run([
      ...bathingOn,
      {
        kind: "bathing-search-succeeded",
        spots: [bathingTwin],
        searchedRadiusM: 10_000,
      },
      { kind: "directions-requested", id: "way/1" },
    ]);

    expect(effects).toEqual([
      { kind: "open-directions", spot: TANTO, origin: null },
    ]);
  });
});

function busyError(): PlaceProviderError {
  return new PlaceProviderError("busy", "no free slot");
}

function phasePosition(phase: Phase): LatLon | null {
  return "position" in phase ? phase.position : null;
}
