// The manual location fallback (docs/spec.md §7.1): when the phone will not
// say where it is — permission refused, no fix, or a desktop browser with no
// GPS at all — the user says it themselves by tapping a map.
//
// The picker owns its own little DOM subtree inside a container the caller
// provides, and reports the confirmed spot through `onPick`. It knows nothing
// about the rest of the app: no element ids, no global state, no place data.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map-picker.css";
import type { LatLon } from "./types";
import { worldZoomBounds } from "./map-bounds";
import { OSM_TILE_ATTRIBUTION } from "./attribution";
import { locationPinIcon } from "./map-icons";
import { createPlaceSearch } from "./place-search";
import { searchPlaces } from "./nominatim";
import type { PlaceMatch } from "./nominatim";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

/** OSM's raster tiles stop here; asking for more just yields grey squares. */
const OSM_MAX_ZOOM = 19;

/** Opening view when we have no idea where the user is: the whole planet. */
const WORLD_CENTRE: [number, number] = [30, 10];
const WORLD_ZOOM = 3;

/** Opening zoom when the caller does know roughly where the user is: near
 *  enough to recognise streets, wide enough to pick a different spot. */
const KNOWN_POSITION_ZOOM = 13;

/** Zoom for a place chosen from search — close enough to see the city, loose
 *  enough to nudge the marker afterwards. */
const SEARCH_RESULT_ZOOM = 14;

/** What the confirm button says before and after a spot has been chosen. It
 *  doubles as the instructions, so the picker needs no separate prose. */
const PROMPT_LABEL = "Tap the map to choose a spot";
const CONFIRM_LABEL = "Use this location";

/** The dropped-pin marker: the shared red pin (map-icons.ts), the same one
 *  the results map stands on the user — a chosen spot and a current position
 *  are the same kind of thing to the rest of the app. */
const pinIcon = locationPinIcon();

export interface MapPickerOptions {
  /**
   * Called with the spot the user confirmed. Shaped like
   * `LocationCallbacks.onPosition` in location.ts on purpose: to the rest of
   * the app a hand-picked position is just a position, however it was arrived
   * at.
   */
  onPick: (position: LatLon) => void;
  /**
   * Called when the user backs out without choosing anything. Optional
   * because tests that never touch the control have no need of it, but the
   * composition root always wires one: the picker can open over results
   * already on screen (docs/spec.md §7.1), and without a way to say "never
   * mind" the only way out is confirming a location that was never wanted.
   */
  onCancel?: () => void;
  /** Where to open the map. Omit — the usual case, since the whole reason we
   *  are here is not knowing — to open on the world. */
  center?: LatLon;
  /** Geocoder behind the search box. Injectable so tests stay offline and the
   *  composition root can share one rate-limited client. */
  search?: (query: string) => Promise<PlaceMatch[]>;
}

export interface MapPickerHandle {
  /** Tears the picker down and gives the container back as it was found.
   *  Safe to call more than once. */
  destroy(): void;
}

/**
 * Mount a pick-a-spot map inside `container`.
 *
 * The container is expected to be an element the caller owns and can size; the
 * picker fills it with a search box, the map itself, and a confirm button, and
 * removes all three again on `destroy()`.
 */
export function createMapPicker(
  container: HTMLElement,
  {
    onPick,
    onCancel,
    center,
    search = (query) => searchPlaces(query),
  }: MapPickerOptions,
): MapPickerHandle {
  container.classList.add("map-picker");

  const mapElement = document.createElement("div");
  mapElement.className = "map-picker-map";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "map-picker-confirm";
  // Nothing is chosen yet, so the button explains what to do instead of
  // offering an action that would have no meaning.
  confirmButton.disabled = true;
  confirmButton.textContent = PROMPT_LABEL;

  // Sits above the search bar, in normal flow rather than overlaid, so it
  // can never end up sharing a corner with Leaflet's own zoom control (top
  // left of the map) or its attribution (bottom right) — both of which live
  // inside `mapElement`, which starts only below this row.
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "map-picker-cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.setAttribute("aria-label", "Cancel choosing a location");

  container.append(mapElement, confirmButton);

  const worldBounds = worldZoomBounds();
  const map = L.map(mapElement, { ...worldBounds.mapOptions }).setView(
    center ? [center.lat, center.lon] : WORLD_CENTRE,
    center ? KNOWN_POSITION_ZOOM : WORLD_ZOOM,
  );

  L.tileLayer(OSM_TILE_URL, {
    // The tiles are OpenStreetMap's and ODbL asks for visible credit wherever
    // they are drawn (docs/spec.md §4.1). Leaflet renders this in the map
    // corner; the one string for it lives in attribution.ts, shared with the
    // results map. Do not remove it to tidy a layout.
    attribution: OSM_TILE_ATTRIBUTION,
    maxZoom: OSM_MAX_ZOOM,
    ...worldBounds.tileOptions,
  }).addTo(map);

  // Installed after the tile layer so the zoom floor is computed against the
  // zoom range the tiles actually cover.
  const stopTrackingBounds = worldBounds.install(map);

  let marker: L.Marker | null = null;
  let chosen: LatLon | null = null;
  let destroyed = false;

  // One selection path for both ways of choosing a spot — a tap on the map and
  // a place picked from search — so confirming behaves identically either way.
  function choose(position: LatLon): void {
    chosen = position;

    if (marker) {
      marker.setLatLng([position.lat, position.lon]);
    } else {
      marker = L.marker([position.lat, position.lon], {
        icon: pinIcon,
        alt: "Chosen location",
      }).addTo(map);
    }

    confirmButton.disabled = false;
    confirmButton.textContent = CONFIRM_LABEL;
  }

  map.on("click", (event: L.LeafletMouseEvent) => {
    choose({ lat: event.latlng.lat, lon: event.latlng.lng });
  });

  confirmButton.addEventListener("click", () => {
    // A detached element still runs its listeners, so a caller holding on to
    // the button could otherwise pick a location out of a torn-down picker.
    if (destroyed || !chosen) return;
    onPick(chosen);
  });

  cancelButton.addEventListener("click", () => {
    if (destroyed) return;
    onCancel?.();
  });

  const placeSearch = createPlaceSearch({
    search,
    onSelect: ({ position }) => {
      map.setView([position.lat, position.lon], SEARCH_RESULT_ZOOM);
      choose(position);
    },
  });
  container.insertBefore(placeSearch.element, mapElement);
  container.insertBefore(cancelButton, placeSearch.element);

  return {
    destroy() {
      // Lifecycles get re-entrant in practice (a pick that tears the view down
      // while a teardown is already running); a second Leaflet `remove()`
      // would throw.
      if (destroyed) return;
      destroyed = true;

      cancelButton.remove();
      placeSearch.element.remove();
      confirmButton.remove();
      stopTrackingBounds();
      map.remove();
      mapElement.remove();
      container.classList.remove("map-picker");
    },
  };
}
