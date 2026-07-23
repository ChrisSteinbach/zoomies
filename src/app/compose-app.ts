import { createOverpassProvider, OVERPASS_MIRROR_ENDPOINT } from "./overpass";
import { withFairUse } from "./fair-use";
import { withFallback } from "./fallback";
import { createDatasetLoader, withOfflineDataset } from "./offline-dataset";
import { withCache } from "./place-cache";
import {
  BATHING_TARGET_RESULT_COUNT,
  createExpandingSearch,
} from "./expanding-search";
import type { ExpandingSearch } from "./expanding-search";
import { watchLocation } from "./location";
import type { LocationCallbacks, StopFn } from "./location";
import { initialState, transition, visibleSpotsOf } from "./state-machine";
import type { AppState, Effect, Event, Phase } from "./state-machine";
import { renderLayerToggle } from "./layer-toggle";
import { renderSpotList } from "./spot-list";
import { renderStatus } from "./status-view";
import { createSpotMap } from "./spot-map";
import type { SpotMapHandle } from "./spot-map";
import { createSpotDrawer } from "./spot-drawer";
import type { SpotDrawer } from "./spot-drawer";
import { createMapPicker } from "./map-picker";
import type { MapPickerHandle } from "./map-picker";
import { createAttribution } from "./attribution";
import { renderModeToggle } from "./mode-toggle";
import { createAboutButton, hideAbout, showAbout } from "./about";
import { markLoad } from "./load-timeline";
import { directionsUrl, formatDistance } from "./format";
import { PlaceProviderError } from "./place-provider";
import type { LatLon } from "./types";

/**
 * The composition root: the one place that knows every concrete dependency.
 *
 * Everything below it is either pure (the state machine, the geometry) or a
 * dumb view (data and callbacks in, DOM out). This module builds the provider
 * stack, mounts the views, and turns the machine's {@link Effect}s into the
 * side effects they describe. It holds no rules of its own — if a decision
 * about *what the app does* ends up here, it belongs in state-machine.ts.
 */

/** Injection points, so the wiring can be tested without a network or a GPS. */
export interface AppDeps {
  search?: ExpandingSearch;
  /** The bathing layer's own search — same shape, thinner target. */
  bathingSearch?: ExpandingSearch;
  watch?: (callbacks: LocationCallbacks) => StopFn;
  /** How to hand off to the maps app. Replaced in tests; `window.open` live. */
  openUrl?: (url: string) => void;
  /**
   * How to raise the picker. Injectable because picking a spot is pixel
   * arithmetic against a laid-out map, which jsdom cannot do — map-picker's own
   * tests cover that, and the wiring tests care only what happens once a
   * position comes back.
   */
  createPicker?: typeof createMapPicker;
}

export interface AppHandle {
  destroy(): void;
}

/** The two layers of the app, each searching outwards on its own terms. */
export interface Searches {
  parks: ExpandingSearch;
  bathing: ExpandingSearch;
}

/**
 * The provider stack, outermost first.
 *
 * Expanding radius asks *how far*, the offline dataset asks *from where*,
 * the cache asks *whether at all*, fair use asks *how often*, fallback asks
 * *whom*, and Overpass answers one question at a time. The order is
 * load-bearing: the dataset sits outside the whole live apparatus because an
 * offline answer must cost nothing live — no cache entry written, no
 * fair-use slot taken, no endpoint reached — while a query it cannot
 * honestly cover falls through to that apparatus unchanged. The cache must
 * sit inside the expansion so each radius is cached separately, and outside
 * fair use so a cache hit never takes a slot — which also means a cache hit
 * never reaches an endpoint at all, mirror included. Fallback sits inside
 * fair use so the mirror is tried before any backoff wait, not after: the
 * other pool of slots first, then wait.
 *
 * Both searches share one stack, built once. Only the outermost layer —
 * *how far* — differs between them, because the bathing layer is thin enough
 * to need a lower target (§4.3). Everything below is about the shared
 * service, not the question: two stacks would be two caches, and two fair-use
 * queues, which is a concurrency limit of four against an instance we
 * promised at most two.
 */
export function createSearches(): Searches {
  const live = withCache(
    withFairUse(
      withFallback(
        createOverpassProvider(),
        createOverpassProvider({ endpoint: OVERPASS_MIRROR_ENDPOINT }),
      ),
    ),
  );
  const stack = withOfflineDataset(
    createDatasetLoader({ url: configuredDatasetUrl() }),
    live,
  );

  return {
    parks: createExpandingSearch((lat, lon, radiusM) =>
      stack.findDogParks(lat, lon, radiusM),
    ),
    bathing: createExpandingSearch(
      (lat, lon, radiusM) => stack.findBathingSpots(lat, lon, radiusM),
      { targetCount: BATHING_TARGET_RESULT_COUNT },
    ),
  };
}

/**
 * Where the dataset lives, when the build says otherwise.
 *
 * `VITE_DATASET_URL` exists for development and end-to-end verification: a
 * locally built dataset can stand in for the published one without touching
 * code. Env vars are untyped, so this reads like the boundary it is —
 * anything but a non-empty string means "use the default".
 */
function configuredDatasetUrl(): string | undefined {
  const configured: unknown = import.meta.env.VITE_DATASET_URL;
  return typeof configured === "string" && configured !== ""
    ? configured
    : undefined;
}

/**
 * The two searches the app runs with: injected where given, the real stack
 * where not — built at most once, so an injected half never conjures a
 * second live stack for the other half to sit on.
 */
function resolveSearches(deps: AppDeps): {
  search: ExpandingSearch;
  bathingSearch: ExpandingSearch;
} {
  if (deps.search && deps.bathingSearch) {
    return { search: deps.search, bathingSearch: deps.bathingSearch };
  }
  const built = createSearches();
  return {
    search: deps.search ?? built.parks,
    bathingSearch: deps.bathingSearch ?? built.bathing,
  };
}

export function composeApp(root: HTMLElement, deps: AppDeps = {}): AppHandle {
  const { search, bathingSearch } = resolveSearches(deps);
  const watch = deps.watch ?? ((callbacks) => watchLocation(callbacks));
  const openUrl =
    deps.openUrl ?? ((url) => window.open(url, "_blank", "noopener"));
  const createPicker = deps.createPicker ?? createMapPicker;

  const {
    mapElement,
    drawer,
    topbarElement,
    modeElement,
    statusElement,
    layersElement,
    listElement,
    pickerElement,
    creditElement,
  } = buildShell(root);

  // The ⓘ is chrome, not state: what it opens changes nothing about position
  // or results, so — like the drawer's own open and close — it never passes
  // through the machine.
  const aboutButton = createAboutButton(() => showAbout(aboutButton));
  topbarElement.append(aboutButton);

  const releaseCredit = reserveRoomForCredit(root, creditElement);

  let state: AppState = initialState;
  let stopWatching: StopFn | null = null;
  let picker: MapPickerHandle | null = null;
  /**
   * Which search is the current one. A slow answer that arrives after the user
   * has walked on is not the answer to the question now being asked, and
   * letting it land would quietly replace fresh results with stale ones.
   */
  let searchToken = 0;
  /** The bathing layer's own counter — the layers refresh independently, so
   *  one layer's new question must not disown the other's pending answer. */
  let bathingToken = 0;

  const map: SpotMapHandle = createSpotMap(mapElement, {
    onSelect: (id) => dispatch({ kind: "spot-selected", id }),
    // The callout's button and the row's button make the same request; which
    // maps app to open and whether to hand it an origin stays the machine's
    // one decision.
    onDirections: (id) => dispatch({ kind: "directions-requested", id }),
  });

  /**
   * How much of the map's right edge the open drawer is sitting over.
   *
   * The map view takes this as a number rather than knowing the drawer
   * exists: a frame has to aim for the visible part of the viewport, and the
   * composition root is the one place that can see both elements. A drawer
   * covering the whole map reports zero — there is no visible sliver to aim
   * for, and at those widths selecting from the list closes the drawer
   * instead (see the list wiring below).
   */
  function obscuredMapWidth(): number {
    if (!drawer.isOpen()) return 0;
    const covered = drawer.panel.offsetWidth;
    return covered >= mapElement.offsetWidth ? 0 : covered;
  }

  /**
   * Whether the open drawer would hide the map entirely, read from the laid
   * out widths rather than from a breakpoint constant that could drift from
   * the stylesheet's.
   */
  function drawerCoversMap(): boolean {
    return drawer.panel.offsetWidth >= mapElement.offsetWidth;
  }

  // ── The dispatch loop ────────────────────────────────────────────────
  //
  // Events are queued rather than handled inline, because an effect may
  // dispatch as it runs. Without the queue that nests one transition inside
  // another, and the inner one would be computed against a state the outer one
  // is about to replace.
  const pending: Event[] = [];
  let draining = false;

  function dispatch(event: Event): void {
    pending.push(event);
    if (draining) return;

    draining = true;
    try {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const { next: after, effects } = transition(state, next);
        state = after;
        render();
        for (const effect of effects) perform(effect);
      }
    } finally {
      draining = false;
    }
  }

  function perform(effect: Effect): void {
    switch (effect.kind) {
      case "watch-location":
        markLoad("watch-started");
        stopWatching ??= watch({
          onPosition: (position, accuracyM) => {
            markLoad("first-fix", accuracyDetail(accuracyM));
            dispatch({ kind: "position-fixed", position });
          },
          onError: ({ code }) =>
            dispatch({ kind: "location-failed", reason: code }),
        });
        return;

      case "stop-watching":
        stopWatching?.();
        stopWatching = null;
        return;

      case "search":
        runSearch(effect.position);
        return;

      case "search-bathing":
        runBathingSearch(effect.position);
        return;

      case "open-picker":
        openPicker();
        return;

      case "close-picker":
        picker?.destroy();
        picker = null;
        pickerElement.hidden = true;
        return;

      case "frame-map":
        map.frame(effect.position);
        return;

      case "frame-spot":
        map.frameSpot(effect.spot, effect.user, obscuredMapWidth());
        return;

      case "open-directions":
        openUrl(directionsUrl(effect.spot, effect.origin));
        return;
    }
  }

  function runSearch({ lat, lon }: LatLon): void {
    const token = ++searchToken;
    markLoad("search-started");

    search(lat, lon).then(
      ({ spots, radiusM }) => {
        // Marked before the token check: the timeline records when the data
        // came back, which is true whether or not this answer is still the
        // one being waited for.
        markLoad(
          "search-settled",
          `${spots.length} spots, ${formatDistance(radiusM)}`,
        );
        if (token !== searchToken) return;
        dispatch({
          kind: "search-succeeded",
          spots,
          searchedRadiusM: radiusM,
        });
      },
      (error: unknown) => {
        const failure = asProviderError(error);
        markLoad("search-settled", failure.kind);
        if (token !== searchToken) return;
        dispatch({ kind: "search-failed", error: failure });
      },
    );
  }

  /**
   * Like {@link runSearch}, without the load-timeline marks: those instrument
   * the cold start, and this layer only ever runs at a user's request, after
   * the app is up.
   */
  function runBathingSearch({ lat, lon }: LatLon): void {
    const token = ++bathingToken;

    bathingSearch(lat, lon).then(
      ({ spots, radiusM }) => {
        if (token !== bathingToken) return;
        dispatch({
          kind: "bathing-search-succeeded",
          spots,
          searchedRadiusM: radiusM,
        });
      },
      () => {
        // The layer's failure handling needs no diagnosis: its note offers a
        // retry whatever went wrong, and the primary search is the surface
        // that explains provider failures in detail.
        if (token !== bathingToken) return;
        dispatch({ kind: "bathing-search-failed" });
      },
    );
  }

  function openPicker(): void {
    picker?.destroy();
    pickerElement.hidden = false;
    picker = createPicker(pickerElement, {
      center: currentPosition(state.phase) ?? undefined,
      onPick: (position) => dispatch({ kind: "position-picked", position }),
      onCancel: () => dispatch({ kind: "pick-cancelled" }),
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function render(): void {
    const { phase } = state;

    // The status view decides whether it is the screen or a note above the
    // results, and the shell lays itself out around that answer.
    root.dataset.presence = renderStatus(statusElement, phase, {
      onRetry: () => dispatch({ kind: "retry-requested" }),
      onPickPosition: () => dispatch({ kind: "pick-requested" }),
      onRetryLocation: () => dispatch({ kind: "location-retry-requested" }),
    });

    const position = currentPosition(phase);
    // One merged set for the map and the list: the layers are one answer to
    // "what is around me", the list re-sorts the union by distance, and the
    // machine's own idea of visibility decides it — including the rule that a
    // place found by both layers appears once, as the park it is tagged as.
    const spots = visibleSpotsOf(state);
    const selectedId = state.selectedId;

    // With no position there is no map worth drawing — a world view centred on
    // nothing would be decoration. With a position but no results there is:
    // "you are here, and there is nothing around you" is the answer.
    root.dataset.hasPosition = String(position !== null);
    root.dataset.hasResults = String(spots.length > 0);
    if (!position) return;

    // With a position there is a source to show and an alternative to offer;
    // without one, the status card owns the way into the picker.
    renderModeToggle(modeElement, state.positionSource, {
      onFollow: () => dispatch({ kind: "follow-requested" }),
      onPick: () => dispatch({ kind: "pick-requested" }),
    });

    renderLayerToggle(layersElement, state.bathing, {
      onToggle: () => dispatch({ kind: "bathing-toggled" }),
      onRetry: () => dispatch({ kind: "bathing-retry-requested" }),
    });

    map.render(spots, position, selectedId);
    renderSpotList(listElement, spots, position, selectedId, {
      onSelect: (id) => {
        // Drawer position is chrome, not state, like the About dialog — but
        // at widths where the open sheet is the whole screen, choosing a
        // spot from it is a request to see the map, so the sheet steps aside
        // *before* the machine frames the answer behind it. Focus moves to
        // the handle — the way back — rather than staying stranded on a row
        // inside the parked-off-screen panel. Clearing a selection moves
        // nothing.
        if (id !== null && drawer.isOpen() && drawerCoversMap()) {
          drawer.close();
          drawer.focusHandle();
        }
        dispatch({ kind: "spot-selected", id });
      },
      onDirections: (id) => dispatch({ kind: "directions-requested", id }),
    });

    // The rows are in the document; the browser paints them a frame later.
    // Close enough for a timeline whose other steps are counted in seconds,
    // and it avoids a callback that could outlive the app that scheduled it.
    if (spots.length > 0) markLoad("first-row");
  }

  dispatch({ kind: "started" });

  return {
    destroy() {
      stopWatching?.();
      picker?.destroy();
      // The dialog lives on document.body, so clearing `root` cannot take it
      // down — it has to be asked.
      hideAbout();
      releaseCredit();
      map.destroy();
      drawer.destroy();
      root.replaceChildren();
    },
  };
}

/**
 * Keep `--app-credit-height` equal to the credit bar's real height.
 *
 * The bar is pinned over the sheet, so the sheet has to leave room for it or
 * the last result sits underneath. Measured rather than guessed: the credit
 * wraps to one, two or three lines depending on the width of the screen, and a
 * hardcoded reserve was wrong on a phone — which is where it mattered.
 *
 * Returns a function that stops observing.
 */
function reserveRoomForCredit(
  root: HTMLElement,
  credit: HTMLElement,
): () => void {
  const sync = () => {
    root.style.setProperty("--app-credit-height", `${credit.offsetHeight}px`);
  };
  sync();

  // Absent in the test environment, where nothing has a height anyway.
  if (typeof ResizeObserver !== "function") return () => {};

  const observer = new ResizeObserver(sync);
  observer.observe(credit);
  return () => observer.disconnect();
}

interface Shell {
  mapElement: HTMLElement;
  drawer: SpotDrawer;
  /** The sheet's top bar; the composition root adds the About button to it. */
  topbarElement: HTMLElement;
  /** The top bar's left cell, where the mode toggle renders. */
  modeElement: HTMLElement;
  statusElement: HTMLElement;
  layersElement: HTMLElement;
  listElement: HTMLElement;
  pickerElement: HTMLElement;
  creditElement: HTMLElement;
}

/**
 * The app's furniture: a map with the sheet over it; inside that sheet a
 * sticky header — the top bar, then the status — above the list; and the
 * attribution outside all of it.
 *
 * The top bar and the status share one sticky wrapper because two sticky
 * siblings would fight for the same top edge, and the status losing that
 * fight would slide "Updating results…" under the mode toggle.
 *
 * The attribution sits in the shell rather than in any view because it is a
 * licensing obligation that does not lapse in the states that show no map
 * (docs/spec.md §4.1).
 */
function buildShell(root: HTMLElement): Shell {
  root.replaceChildren();
  root.classList.add("app");

  const mapElement = document.createElement("div");
  mapElement.className = "app-map";

  const pickerElement = document.createElement("div");
  pickerElement.className = "app-picker";
  pickerElement.hidden = true;

  root.append(mapElement);

  const drawer = createSpotDrawer(root);

  const headerElement = document.createElement("div");
  headerElement.className = "app-header";

  const topbarElement = document.createElement("div");
  topbarElement.className = "app-topbar";

  // The mode toggle's cell. Empty until a position exists — the composition
  // root only renders the toggle then, since with nothing to follow and
  // nowhere searched from there is no source to switch between.
  const modeElement = document.createElement("div");
  modeElement.className = "app-mode";
  topbarElement.append(modeElement);

  const statusElement = document.createElement("div");
  statusElement.className = "app-status";

  headerElement.append(topbarElement, statusElement);

  // Between the status and the list: the layer chips change what the list
  // holds, so they sit where that relationship reads top-to-bottom. Hidden by
  // the stylesheet until a position exists — a layer toggle with nowhere to
  // search from is a dead control.
  const layersElement = document.createElement("div");
  layersElement.className = "app-layers";

  const listElement = document.createElement("div");
  listElement.className = "app-list";

  drawer.element.append(headerElement, layersElement, listElement);

  const creditElement = createAttribution();

  // The picker goes on last so DOM order agrees with its z-index. It is the
  // only modal here, and it once lost a z-index tie to the sheet and opened
  // behind it — which made the sole escape from a refused permission look like
  // a dead button. Two reasons to be in front are better than one.
  root.append(creditElement, pickerElement);

  return {
    mapElement,
    drawer,
    topbarElement,
    modeElement,
    statusElement,
    layersElement,
    listElement,
    pickerElement,
    creditElement,
  };
}

/** Where the user is, as far as the current phase knows. */
function currentPosition(phase: Phase): LatLon | null {
  switch (phase.kind) {
    case "locating":
    case "needs-position":
      return null;
    default:
      return phase.position;
  }
}

/**
 * How far out a fix might be, in the words the load report shows.
 *
 * Worth recording because "the fix took eight seconds" and "the fix took eight
 * seconds and was good to eight metres" call for different answers: the second
 * says the device was holding out for satellites when a coarser fix would have
 * been enough to sort a handful of dog parks.
 */
function accuracyDetail(accuracyM: number | null): string | undefined {
  return accuracyM === null ? undefined : `±${Math.round(accuracyM)} m`;
}

/**
 * Anything thrown by the provider stack, as the typed failure the UI knows how
 * to talk about.
 *
 * A non-`PlaceProviderError` reaching here is a bug in our own reading of the
 * response rather than anything the service did, so it is reported as an
 * unreadable answer — and, like a genuinely unreadable one, is not retryable:
 * asking again would run the same broken code.
 */
function asProviderError(error: unknown): PlaceProviderError {
  return error instanceof PlaceProviderError
    ? error
    : new PlaceProviderError(
        "malformed-response",
        "Could not read the answer from the map data service",
        { cause: error },
      );
}
