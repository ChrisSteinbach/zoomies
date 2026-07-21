import { initialState, transition, REQUERY_DISTANCE_M } from "./state-machine";
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
      selectedId: null,
    });
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

  it("treats the re-query threshold as a distance in metres", () => {
    expect(REQUERY_DISTANCE_M).toBeGreaterThan(0);
  });
});

describe("acting on a result", () => {
  it("remembers which result the user picked out", () => {
    const { state } = run([
      ...showingResults,
      { kind: "spot-selected", id: "way/2" },
    ]);

    expect(state.phase).toMatchObject({ selectedId: "way/2" });
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

function phasePosition(phase: Phase): LatLon | null {
  return "position" in phase ? phase.position : null;
}
