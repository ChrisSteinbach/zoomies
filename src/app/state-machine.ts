import type { PlaceProviderError } from "./place-provider";
import type { LocationErrorCode } from "./location";
import type { DogSpot, LatLon } from "./types";
import { haversineMeters } from "./geo";

/**
 * The app's behaviour, as a pure function: `transition(state, event)` returns
 * the next state and the effects to perform. No DOM, no fetch, no timers.
 *
 * The point is that the interesting cases — permission denied, Overpass
 * timing out, nothing found within 25 km, retry — are the ones hardest to
 * reach through a browser and easiest to get wrong. Here they are ordinary
 * function calls.
 */

/**
 * How far the user must travel before the results are worth fetching again.
 *
 * Dog parks do not move, and Overpass is a free shared service (docs/spec.md
 * §5), so re-querying on every GPS tick would be rude and pointless. Distances
 * still update on every tick — that is a local haversine over a handful of
 * results and costs nothing — so the list stays honest while walking; only the
 * network call waits for real movement.
 */
export const REQUERY_DISTANCE_M = 250;

export type Phase =
  /** Waiting for the first fix, or for the user to answer the permission
   *  prompt. */
  | { kind: "locating" }
  /** No usable position and no prospect of one. The manual picker is the way
   *  out (docs/spec.md §7.1). */
  | { kind: "needs-position"; reason: LocationErrorCode }
  /** A query is in flight. `staleSpots` is what is currently on screen, kept
   *  so a refresh that fails does not blank it. */
  | { kind: "searching"; position: LatLon; staleSpots: DogSpot[] }
  /** Results to show, sorted by the renderer against the live position. */
  | {
      kind: "ready";
      position: LatLon;
      spots: DogSpot[];
      searchedRadiusM: number;
    }
  /** Searched as far as we go and found nothing. A legitimate answer in a
   *  sparsely mapped region, not a failure (docs/spec.md §3) — which is why
   *  it is its own phase and not an error with an empty list. */
  | { kind: "empty"; position: LatLon; searchedRadiusM: number }
  /** The lookup failed. `staleSpots` may still hold the last good answer. */
  | {
      kind: "failed";
      position: LatLon | null;
      error: PlaceProviderError;
      staleSpots: DogSpot[];
    };

/**
 * The bathing-spot layer's own lifecycle, orthogonal to {@link Phase}.
 *
 * A slice rather than more phases, because the layer rides on top of whatever
 * the primary search is doing: parks can be `ready` while bathing is still
 * loading, and parks can be `empty` while a hundbad is on screen — a real
 * state by a rural lake, not an edge case. Folding it into `Phase` would
 * square the state space to say the same thing.
 *
 * `ready` with no spots stays `ready`: "nothing within 25 km" is a
 * legitimate per-layer answer (docs/spec.md §3), and the radius is kept so
 * the UI can say how far it looked. Toggling off discards rather than parks
 * the data — the cache makes switching back on cheap, and a stashed answer
 * could quietly outlive the position it was fetched for.
 */
export type BathingLayer =
  | { kind: "off" }
  /** Toggled on, search in flight. `staleSpots` keeps what a refresh is
   *  replacing on screen, exactly as the primary `searching` phase does. */
  | { kind: "loading"; staleSpots: DogSpot[] }
  | { kind: "ready"; spots: DogSpot[]; searchedRadiusM: number }
  /** The lookup failed. The layer stays on, showing what it had, and the
   *  UI offers a retry scoped to this layer alone. */
  | { kind: "failed"; staleSpots: DogSpot[] };

export interface AppState {
  phase: Phase;
  /**
   * Where the position came from. A picked position is a deliberate choice
   * and must not be overridden by a GPS fix arriving late.
   */
  positionSource: "gps" | "picked" | null;
  /**
   * The picker is an overlay, not a phase: opening it must not destroy the
   * results underneath, and cancelling must put the user back exactly where
   * they were.
   */
  pickerOpen: boolean;
  /** The secondary layer, riding on the primary search's position. */
  bathing: BathingLayer;
  /**
   * Which spot is highlighted, across both layers.
   *
   * Lives here rather than inside the `ready` phase because the visible set
   * is no longer one phase's property: a bathing spot can be selected while
   * the park search sits at `empty`. After every transition the selection is
   * checked against what is actually visible and cleared if its spot is gone
   * — so it survives a refresh that still contains the spot, and can never
   * dangle at one that vanished.
   */
  selectedId: string | null;
}

export type Event =
  | { kind: "started" }
  | { kind: "position-fixed"; position: LatLon }
  | { kind: "location-failed"; reason: LocationErrorCode }
  | { kind: "pick-requested" }
  | { kind: "pick-cancelled" }
  | { kind: "position-picked"; position: LatLon }
  | { kind: "search-succeeded"; spots: DogSpot[]; searchedRadiusM: number }
  | { kind: "search-failed"; error: PlaceProviderError }
  | { kind: "retry-requested" }
  /** Ask the device where we are again, after it failed to say. */
  | { kind: "location-retry-requested" }
  /** Follow the device again, after the position was set by hand. */
  | { kind: "follow-requested" }
  | { kind: "spot-selected"; id: string | null }
  | { kind: "directions-requested"; id: string }
  /** The bathing-spots layer was switched on or off. */
  | { kind: "bathing-toggled" }
  /** Ask again for the layer that failed, without touching the parks. */
  | { kind: "bathing-retry-requested" }
  | {
      kind: "bathing-search-succeeded";
      spots: DogSpot[];
      searchedRadiusM: number;
    }
  | { kind: "bathing-search-failed" };

export type Effect =
  | { kind: "watch-location" }
  | { kind: "stop-watching" }
  | { kind: "search"; position: LatLon }
  | { kind: "search-bathing"; position: LatLon }
  | { kind: "open-picker" }
  | { kind: "close-picker" }
  | { kind: "open-directions"; spot: DogSpot; origin: LatLon | null };

export interface TransitionResult {
  next: AppState;
  effects: Effect[];
}

export const initialState: AppState = {
  phase: { kind: "locating" },
  positionSource: null,
  pickerOpen: false,
  bathing: { kind: "off" },
  selectedId: null,
};

export function transition(state: AppState, event: Event): TransitionResult {
  const { next, effects } = decide(state, event);
  // Every path out re-checks the selection against what is now visible, so
  // no individual transition can forget to: a selected spot that survived a
  // refresh stays selected, and one that vanished — replaced results, a
  // layer toggled off — cannot leave a highlight pointing at nothing.
  return { next: normalizeSelection(next), effects };
}

function decide(state: AppState, event: Event): TransitionResult {
  switch (event.kind) {
    case "started":
      return { next: state, effects: [{ kind: "watch-location" }] };

    case "position-fixed":
      return positionFixed(state, event.position);

    case "location-failed":
      if (hasPosition(state)) {
        // A position with no source means `follow-requested` restarted the
        // watcher, and it has now said no. The hand-picked position stands
        // again — reverting the source is what settles the mode control —
        // and the watcher stops rather than being left to fail at the same
        // wall. Asking again stays one tap away.
        if (state.positionSource === null) {
          return {
            next: { ...state, positionSource: "picked" },
            effects: [{ kind: "stop-watching" }],
          };
        }
        // A denied permission is only fatal while we have nothing to show. If
        // the user is already looking at results, a later failure to refresh
        // the fix is not worth throwing them out of the app for.
        return stay(state);
      }
      return {
        next: {
          ...state,
          phase: { kind: "needs-position", reason: event.reason },
        },
        effects: [{ kind: "stop-watching" }],
      };

    case "pick-requested":
      return {
        next: { ...state, pickerOpen: true },
        effects: [{ kind: "open-picker" }],
      };

    case "pick-cancelled":
      // The phase underneath is untouched, so closing simply reveals it.
      return {
        next: { ...state, pickerOpen: false },
        effects: [{ kind: "close-picker" }],
      };

    case "position-picked": {
      const bathing = refreshedBathing(state, event.position);
      return {
        next: {
          ...state,
          phase: {
            kind: "searching",
            position: event.position,
            staleSpots: spotsOf(state.phase),
          },
          positionSource: "picked",
          pickerOpen: false,
          bathing: bathing.bathing,
        },
        // Stop the watcher: the user has said where they are, and a GPS fix
        // arriving afterwards would silently undo that.
        effects: [
          { kind: "close-picker" },
          { kind: "stop-watching" },
          { kind: "search", position: event.position },
          ...bathing.effects,
        ],
      };
    }

    case "follow-requested":
      // Only meaningful when the position was set by hand — that is the one
      // state whose watcher was deliberately stopped. The results on screen
      // stay: they are still the answer for the picked spot, and they remain
      // so until a real fix lands and {@link positionFixed} decides whether
      // the user has actually moved. `positionSource` goes to null — "no
      // deliberate choice any more, no fix yet" — which is what lets that
      // next fix through the picked-position guard.
      if (state.positionSource !== "picked") return stay(state);
      return {
        next: { ...state, positionSource: null },
        effects: [{ kind: "watch-location" }],
      };

    case "search-succeeded":
      return searchSucceeded(state, event.spots, event.searchedRadiusM);

    case "search-failed":
      if (state.phase.kind !== "searching") return stay(state);
      return {
        next: {
          ...state,
          phase: {
            kind: "failed",
            position: state.phase.position,
            error: event.error,
            staleSpots: state.phase.staleSpots,
          },
        },
        effects: [],
      };

    case "retry-requested":
      return retryRequested(state);

    case "location-retry-requested":
      // Only from the dead end. Anywhere else we either have a position or a
      // watcher already running, and restarting it would be churn.
      if (state.phase.kind !== "needs-position") return stay(state);
      return {
        next: { ...state, phase: { kind: "locating" } },
        effects: [{ kind: "watch-location" }],
      };

    case "spot-selected":
      // No phase gate: the renderer only offers selection on rows it drew,
      // and the normalization step clears anything that does not resolve —
      // so an id from either layer is taken at its word here.
      return {
        next: { ...state, selectedId: event.id },
        effects: [],
      };

    case "directions-requested":
      return directionsRequested(state, event.id);

    case "bathing-toggled":
      return bathingToggled(state);

    case "bathing-retry-requested":
      // Only from `failed` — everywhere else the layer is either off, already
      // asking, or already answered, and none of those needs another request.
      if (state.bathing.kind !== "failed") return stay(state);
      return startBathingSearch(state, state.bathing.staleSpots);

    case "bathing-search-succeeded":
      // Only a layer still waiting takes the answer. Toggled off mid-flight,
      // the answer is to a question nobody is asking any more.
      if (state.bathing.kind !== "loading") return stay(state);
      return {
        next: {
          ...state,
          bathing: {
            kind: "ready",
            spots: event.spots,
            searchedRadiusM: event.searchedRadiusM,
          },
        },
        effects: [],
      };

    case "bathing-search-failed":
      if (state.bathing.kind !== "loading") return stay(state);
      return {
        next: {
          ...state,
          bathing: { kind: "failed", staleSpots: state.bathing.staleSpots },
        },
        effects: [],
      };
  }
}

/**
 * On: start looking, from wherever the user is. Off: discard.
 *
 * Discarding rather than stashing is deliberate — the cache makes switching
 * back on nearly free, and a stashed answer could quietly outlive the
 * position it was fetched for.
 */
function bathingToggled(state: AppState): TransitionResult {
  if (state.bathing.kind !== "off") {
    return { next: { ...state, bathing: { kind: "off" } }, effects: [] };
  }

  const position = positionOf(state.phase);
  // The toggle only renders once a position exists, so this is a race —
  // e.g. the fix was lost between paint and tap — not a flow. Nothing to
  // search from; stay off.
  if (!position) return stay(state);

  return startBathingSearch(state, []);
}

/** The layer goes to `loading` and a lookup goes out, keeping `stale` on
 *  screen while it runs. */
function startBathingSearch(
  state: AppState,
  stale: DogSpot[],
): TransitionResult {
  const position = positionOf(state.phase);
  if (!position) return stay(state);

  return {
    next: { ...state, bathing: { kind: "loading", staleSpots: stale } },
    effects: [{ kind: "search-bathing", position }],
  };
}

/**
 * The bathing layer's part of a primary re-search: an on layer follows the
 * user, an off layer stays off.
 *
 * Called wherever a new primary search starts for a new position — moved far
 * enough, picked by hand, retried — so the two layers never answer from two
 * different places.
 */
function refreshedBathing(
  state: AppState,
  position: LatLon,
): { bathing: BathingLayer; effects: Effect[] } {
  if (state.bathing.kind === "off") {
    return { bathing: state.bathing, effects: [] };
  }
  return {
    bathing: { kind: "loading", staleSpots: bathingSpotsOf(state.bathing) },
    effects: [{ kind: "search-bathing", position }],
  };
}

function positionFixed(state: AppState, position: LatLon): TransitionResult {
  // A picked position is a deliberate choice; a GPS fix does not get to
  // overrule it. The watcher is stopped on pick, so this is belt and braces.
  if (state.positionSource === "picked") return stay(state);

  const withGps = { ...state, positionSource: "gps" as const };

  switch (state.phase.kind) {
    case "locating":
    case "needs-position":
      return {
        next: {
          ...withGps,
          phase: { kind: "searching", position, staleSpots: [] },
        },
        effects: [{ kind: "search", position }],
      };

    case "searching": {
      // GPS ticks land close together, so a query already in flight is
      // usually for very nearly this spot: move the position so distances
      // stay live, and do not fire a second request. But a fix can also land
      // far away — the first one after `follow-requested`, or a real fix
      // correcting a stale cached one — and the in-flight answer would then
      // be presented as if it described this new place. Really moved means
      // ask again; the composition root's token drops the superseded answer.
      if (
        haversineMeters(state.phase.position, position) < REQUERY_DISTANCE_M
      ) {
        return {
          next: { ...withGps, phase: { ...state.phase, position } },
          effects: [],
        };
      }
      const bathing = refreshedBathing(state, position);
      return {
        next: {
          ...withGps,
          phase: { ...state.phase, position },
          bathing: bathing.bathing,
        },
        effects: [{ kind: "search", position }, ...bathing.effects],
      };
    }

    case "ready":
    case "empty":
    case "failed": {
      const from = state.phase.position;
      if (from && haversineMeters(from, position) < REQUERY_DISTANCE_M) {
        // Ordinary GPS drift: keep the results, move the user. The renderer
        // recomputes distances from the new position.
        return {
          next: { ...withGps, phase: { ...state.phase, position } },
          effects: [],
        };
      }
      // Really moved: both layers follow, or the bathing pins would keep
      // describing the neighbourhood the user walked out of.
      const bathing = refreshedBathing(state, position);
      return {
        next: {
          ...withGps,
          phase: {
            kind: "searching",
            position,
            staleSpots: spotsOf(state.phase),
          },
          bathing: bathing.bathing,
        },
        effects: [{ kind: "search", position }, ...bathing.effects],
      };
    }
  }
}

function searchSucceeded(
  state: AppState,
  spots: DogSpot[],
  searchedRadiusM: number,
): TransitionResult {
  if (state.phase.kind !== "searching") return stay(state);
  const { position } = state.phase;

  // An empty answer replaces the old results rather than falling back to
  // them. The user has moved somewhere with nothing nearby, and showing the
  // last town's dog parks as if they were here would be a confident lie.
  if (spots.length === 0) {
    return {
      next: { ...state, phase: { kind: "empty", position, searchedRadiusM } },
      effects: [],
    };
  }

  return {
    next: {
      ...state,
      phase: { kind: "ready", position, spots, searchedRadiusM },
    },
    effects: [],
  };
}

function retryRequested(state: AppState): TransitionResult {
  const position = positionOf(state.phase);
  if (!position) {
    // Nothing to retry against — the problem is that we do not know where
    // the user is, so send them back to solving that.
    return stay(state);
  }
  // The retry is the user asking for the whole picture again, so an on
  // bathing layer refreshes with the parks rather than keeping its own
  // possibly-failed answer.
  const bathing = refreshedBathing(state, position);
  return {
    next: {
      ...state,
      phase: {
        kind: "searching",
        position,
        staleSpots: spotsOf(state.phase),
      },
      bathing: bathing.bathing,
    },
    effects: [{ kind: "search", position }, ...bathing.effects],
  };
}

function directionsRequested(state: AppState, id: string): TransitionResult {
  // Across both layers: a hundbad deserves directions exactly as a park
  // does, including when the park search came back empty around it.
  const spot = visibleSpotsOf(state).find((candidate) => candidate.id === id);
  if (!spot) return stay(state);

  // Only pass an origin when the user picked the position by hand. Standing
  // where the GPS says they are, the maps app's own fix is fresher than ours
  // — but a picked position is exactly the case where "current location" is
  // not what the user meant.
  const origin =
    state.positionSource === "picked" ? positionOf(state.phase) : null;

  return {
    next: state,
    effects: [{ kind: "open-directions", spot, origin }],
  };
}

function stay(state: AppState): TransitionResult {
  return { next: state, effects: [] };
}

/** Whether we already know where the user is, however we found out. */
function hasPosition(state: AppState): boolean {
  return positionOf(state.phase) !== null;
}

function positionOf(phase: Phase): LatLon | null {
  switch (phase.kind) {
    case "locating":
    case "needs-position":
      return null;
    case "failed":
      return phase.position;
    default:
      return phase.position;
  }
}

/** What is on screen right now, so a failing refresh can keep showing it. */
function spotsOf(phase: Phase): DogSpot[] {
  switch (phase.kind) {
    case "ready":
      return phase.spots;
    case "searching":
    case "failed":
      return phase.staleSpots;
    default:
      return [];
  }
}

/** The bathing layer's contribution to the screen, by the same stale-keeping
 *  rules as {@link spotsOf}. */
export function bathingSpotsOf(bathing: BathingLayer): DogSpot[] {
  switch (bathing.kind) {
    case "ready":
      return bathing.spots;
    case "loading":
    case "failed":
      return bathing.staleSpots;
    case "off":
      return [];
  }
}

/**
 * Everything a render of this state would put on screen, both layers, each
 * place once.
 *
 * One OSM element can be in both answers: real Stockholm examples are dog
 * parks named "… Hundbad", tagged `leisure=dog_park` and caught by the
 * bathing layer's name regex. That is one place, not two — and the park
 * identity wins, because `leisure=dog_park` is a direct statement about dogs
 * while a name match is a guess. Without this, the list grows twin rows that
 * select together and the map draws one pin in whichever colour came last.
 */
export function visibleSpotsOf(state: AppState): DogSpot[] {
  const byId = new Map<string, DogSpot>();
  for (const spot of [
    ...spotsOf(state.phase),
    ...bathingSpotsOf(state.bathing),
  ]) {
    if (!byId.has(spot.id)) byId.set(spot.id, spot);
  }
  return [...byId.values()];
}

/**
 * A selection is a claim that its spot is on screen; hold every new state to
 * it.
 *
 * Run after each transition rather than inside the ones that change the
 * visible set, so a new event source cannot forget the bookkeeping. The
 * useful consequence is deliberate: a refresh whose new answer still holds
 * the selected spot keeps it selected, where clearing on every refresh would
 * lose the user's place each time they walked far enough to re-query.
 */
function normalizeSelection(state: AppState): AppState {
  if (state.selectedId === null) return state;
  const id = state.selectedId;
  if (visibleSpotsOf(state).some((spot) => spot.id === id)) return state;
  return { ...state, selectedId: null };
}
