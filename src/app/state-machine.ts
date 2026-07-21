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
      selectedId: string | null;
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
  | { kind: "spot-selected"; id: string | null }
  | { kind: "directions-requested"; id: string };

export type Effect =
  | { kind: "watch-location" }
  | { kind: "stop-watching" }
  | { kind: "search"; position: LatLon }
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
};

export function transition(state: AppState, event: Event): TransitionResult {
  switch (event.kind) {
    case "started":
      return { next: state, effects: [{ kind: "watch-location" }] };

    case "position-fixed":
      return positionFixed(state, event.position);

    case "location-failed":
      // A denied permission is only fatal while we have nothing to show. If
      // the user is already looking at results, a later failure to refresh
      // the fix is not worth throwing them out of the app for.
      if (hasPosition(state)) return stay(state);
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

    case "position-picked":
      return {
        next: {
          phase: {
            kind: "searching",
            position: event.position,
            staleSpots: spotsOf(state.phase),
          },
          positionSource: "picked",
          pickerOpen: false,
        },
        // Stop the watcher: the user has said where they are, and a GPS fix
        // arriving afterwards would silently undo that.
        effects: [
          { kind: "close-picker" },
          { kind: "stop-watching" },
          { kind: "search", position: event.position },
        ],
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
      if (state.phase.kind !== "ready") return stay(state);
      return {
        next: { ...state, phase: { ...state.phase, selectedId: event.id } },
        effects: [],
      };

    case "directions-requested":
      return directionsRequested(state, event.id);
  }
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

    case "searching":
      // A query is already in flight for very nearly this spot. Move the
      // position so distances stay live, but do not fire a second request.
      return {
        next: { ...withGps, phase: { ...state.phase, position } },
        effects: [],
      };

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
      return {
        next: {
          ...withGps,
          phase: {
            kind: "searching",
            position,
            staleSpots: spotsOf(state.phase),
          },
        },
        effects: [{ kind: "search", position }],
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
      phase: {
        kind: "ready",
        position,
        spots,
        searchedRadiusM,
        selectedId: null,
      },
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
  return {
    next: {
      ...state,
      phase: {
        kind: "searching",
        position,
        staleSpots: spotsOf(state.phase),
      },
    },
    effects: [{ kind: "search", position }],
  };
}

function directionsRequested(state: AppState, id: string): TransitionResult {
  if (state.phase.kind !== "ready") return stay(state);

  const spot = state.phase.spots.find((candidate) => candidate.id === id);
  if (!spot) return stay(state);

  // Only pass an origin when the user picked the position by hand. Standing
  // where the GPS says they are, the maps app's own fix is fresher than ours
  // — but a picked position is exactly the case where "current location" is
  // not what the user meant.
  const origin =
    state.positionSource === "picked" ? state.phase.position : null;

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
