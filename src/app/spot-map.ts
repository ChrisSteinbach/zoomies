// The results map (docs/spec.md §7.3): the same dog parks the list is showing,
// as pins, plus a marker for where the user is standing.
//
// A view and nothing else, in the same sense as spot-list.ts: it is handed the
// spots, the position and which one is selected, and it draws them. It owns no
// state beyond what Leaflet needs to keep a live map on screen, decides nothing
// about what selecting a pin *means*, and reports taps through a callback whose
// shape deliberately matches `SpotListCallbacks.onSelect` — the composition
// root wires both views to the same `spot-selected` event, which is what makes
// the selection sync in both directions.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./spot-map.css";
import type { DogSpot, LatLon } from "./types";
import { worldZoomBounds } from "./map-bounds";
import { OSM_TILE_ATTRIBUTION } from "./attribution";
import { spotLabel } from "./spot-list";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

/** OSM's raster tiles stop here; asking for more just yields grey squares. */
const OSM_MAX_ZOOM = 19;

/** Where the map sits for the instant before its first render. */
const WORLD_CENTRE: [number, number] = [30, 10];
const WORLD_ZOOM = 3;

/**
 * How close to zoom when framing.
 *
 * Doubles as the cap on the opening fit: a park across the road would otherwise
 * fill the screen at maximum zoom with no streets around it to say where it is.
 */
const NEARBY_ZOOM = 15;

/** Keeps pins off the very edge of the map, where a thumb or the drawer's
 *  handle would sit on top of them. */
const FIT_PADDING: [number, number] = [40, 40];

/** Draws the selected pin over its neighbours, so a cluster cannot bury it. */
const SELECTED_Z_OFFSET = 1000;

/**
 * Markers are drawn as inline data URIs rather than files from
 * `leaflet/dist/images`, for the reason map-picker.ts gives: Leaflet resolves
 * its default marker images relative to wherever its stylesheet ended up, which
 * survives `npm run dev` and then 404s in a hashed production build.
 *
 * The dog-park pin and the you-are-here marker differ in shape, colour and
 * anchor — a green teardrop planted on a point versus a blue dot centred on
 * one. Telling "a park is there" from "you are here" at a glance, one-handed,
 * outdoors, is the whole job of this map; they must not be a colour swap apart.
 */
const PIN_PATH =
  "M12 0C5.37 0 0 5.37 0 12c0 9 12 22 12 22s12-13 12-22C24 5.37 18.63 0 12 0z";

const SPOT_PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 34">' +
  `<path d="${PIN_PATH}" fill="#1a6b3c"/>` +
  '<circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>';

/** The selected pin: bigger, darker, ringed and outlined in white. Selection
 *  reads as "more of the same green", exactly as it does in the list. */
const SELECTED_PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 36">' +
  `<path d="${PIN_PATH}" fill="#12522e" stroke="#fff" stroke-width="2"/>` +
  '<circle cx="12" cy="12" r="6" fill="#fff"/>' +
  '<circle cx="12" cy="12" r="2.75" fill="#12522e"/></svg>';

/** The familiar blue dot, because every maps app on the phone already means
 *  "you are here" by it. */
const USER_DOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<circle cx="12" cy="12" r="11" fill="#1a73e8" fill-opacity="0.25"/>' +
  '<circle cx="12" cy="12" r="6" fill="#1a73e8" stroke="#fff" ' +
  'stroke-width="2.5"/></svg>';

function svgIcon(
  svg: string,
  size: [number, number],
  anchor: [number, number],
  className: string,
): L.Icon {
  return L.icon({
    iconUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    iconSize: size,
    iconAnchor: anchor,
    className,
  });
}

// The teardrops are anchored on their point, which is the spot; the dot is
// anchored on its middle, which is the user.
const spotIcon = svgIcon(SPOT_PIN_SVG, [24, 34], [12, 34], "spot-map-pin");
const selectedSpotIcon = svgIcon(
  SELECTED_PIN_SVG,
  [30, 42],
  [15, 42],
  "spot-map-pin spot-map-pin-selected",
);
const userIcon = svgIcon(USER_DOT_SVG, [24, 24], [12, 12], "spot-map-you");

export interface SpotMapOptions {
  /**
   * A pin was tapped. `null` when the tap cleared the selection — tapping the
   * already-selected pin deselects it, exactly as tapping the already-selected
   * row does in the list.
   */
  onSelect: (id: string | null) => void;
}

export interface SpotMapHandle {
  /**
   * Draw this set of spots, this position and this selection.
   *
   * Idempotent and cheap to call repeatedly: it is called on every GPS tick,
   * and re-rendering an unchanged result set touches nothing but the
   * you-are-here marker.
   */
  render(spots: DogSpot[], position: LatLon, selectedId: string | null): void;
  /** Tears the map down and gives the container back as it was found. Safe to
   *  call more than once. */
  destroy(): void;
}

/** What we need to remember about a pin already on the map: the marker itself,
 *  and where it is — the position is what decides whether it can be reused as
 *  is. Structurally a {@link LatLon}, so {@link planMarkers} reads it directly. */
interface PlacedPin extends LatLon {
  marker: L.Marker;
}

/** The work one render has to do to the pins. Every field is an action; a
 *  render with nothing to do produces three empty lists. */
export interface MarkerPlan {
  /** Spots with no pin on the map yet. */
  create: DogSpot[];
  /** Spots whose pin exists but is in the wrong place. */
  move: DogSpot[];
  /** Ids of pins whose spot is no longer in the results. */
  remove: string[];
}

/**
 * Decide which pins to keep, add, move and drop.
 *
 * Reuse is keyed on {@link DogSpot.id} — the OSM identity, which is stable
 * across queries — so the same park is the same pin from one render to the
 * next. That matters because this runs on every GPS tick: rebuilding the pins
 * each time would restart Leaflet's marker DOM under the user's finger, drop
 * keyboard focus, and make the map flicker while they are walking.
 *
 * A pin is only ever *moved*, never replaced, when its spot's position has
 * shifted (an area's centroid can come back a shade different from a query at a
 * different radius). Nothing else about a spot is drawn on the map, so nothing
 * else can invalidate a pin.
 *
 * Pure, and therefore the part of this module worth testing directly: what
 * Leaflet then does with the answer is Leaflet's business.
 */
export function planMarkers(
  placed: ReadonlyMap<string, LatLon>,
  spots: DogSpot[],
): MarkerPlan {
  const create: DogSpot[] = [];
  const move: DogSpot[] = [];
  const wanted = new Set<string>();

  for (const spot of spots) {
    wanted.add(spot.id);

    const existing = placed.get(spot.id);
    if (!existing) {
      create.push(spot);
    } else if (existing.lat !== spot.lat || existing.lon !== spot.lon) {
      move.push(spot);
    }
  }

  const remove = [...placed.keys()].filter((id) => !wanted.has(id));

  return { create, move, remove };
}

/**
 * Mount a results map inside `container`.
 *
 * The container is expected to be an element the caller owns and can size; the
 * map fills it, and `destroy()` removes it again.
 */
export function createSpotMap(
  container: HTMLElement,
  { onSelect }: SpotMapOptions,
): SpotMapHandle {
  container.classList.add("spot-map");

  const mapElement = document.createElement("div");
  mapElement.className = "spot-map-canvas";
  container.append(mapElement);

  const worldBounds = worldZoomBounds();
  // An opening view of the whole planet, replaced by the first render. Leaflet
  // is only half-alive until it has a centre and a zoom — layers queue up and
  // nothing draws — and this view exists so it never sits in that state.
  const map = L.map(mapElement, { ...worldBounds.mapOptions }).setView(
    WORLD_CENTRE,
    WORLD_ZOOM,
  );

  L.tileLayer(OSM_TILE_URL, {
    // The tiles are OpenStreetMap's and ODbL asks for visible credit wherever
    // they are drawn (docs/spec.md §4.1). Leaflet renders this in the map
    // corner; do not remove it to tidy a layout.
    attribution: OSM_TILE_ATTRIBUTION,
    maxZoom: OSM_MAX_ZOOM,
    ...worldBounds.tileOptions,
  }).addTo(map);

  // Installed after the tile layer so the zoom floor is computed against the
  // zoom range the tiles actually cover.
  const stopTrackingBounds = worldBounds.install(map);

  // Leaflet's default corner for the credit is the bottom right, which on a
  // phone is exactly where the result list's sheet sits (spot-drawer.ts).
  // Covering the tile attribution would be a licence breach rather than a
  // layout compromise, so it goes where nothing is ever drawn over it.
  map.attributionControl.setPosition("topright");

  const pins = new Map<string, PlacedPin>();
  let userMarker: L.Marker | null = null;
  /** What the pins are currently drawn as, so a selection change repaints the
   *  two pins that changed rather than all of them. */
  let shownSelectedId: string | null = null;
  /** Whether the map has been pointed at the results yet. Once it has, the
   *  viewport belongs to the user. */
  let framed = false;
  let destroyed = false;

  function addPin(spot: DogSpot, selectedId: string | null): void {
    const selected = spot.id === selectedId;
    const label = spotLabel(spot);

    const marker = L.marker([spot.lat, spot.lon], {
      icon: selected ? selectedSpotIcon : spotIcon,
      // The pin's accessible name is the row's label, fallback and all, so the
      // map and the list call the same park the same thing.
      alt: label,
      title: label,
      zIndexOffset: selected ? SELECTED_Z_OFFSET : 0,
    });

    marker.on("click", () => {
      // Reported against what is drawn, so a second tap on the selected pin
      // clears the selection instead of re-asserting it.
      onSelect(shownSelectedId === spot.id ? null : spot.id);
    });

    marker.addTo(map);
    pins.set(spot.id, { marker, lat: spot.lat, lon: spot.lon });
  }

  function paint(id: string, selected: boolean): void {
    const pin = pins.get(id);
    if (!pin) return;

    pin.marker.setIcon(selected ? selectedSpotIcon : spotIcon);
    pin.marker.setZIndexOffset(selected ? SELECTED_Z_OFFSET : 0);
  }

  function applySelection(selectedId: string | null): void {
    if (selectedId === shownSelectedId) return;

    // At most two pins change: the one losing the selection and the one
    // gaining it. Either may be absent — a selection can outlive the results
    // it pointed at, and can be asserted before the pin exists.
    if (shownSelectedId !== null) paint(shownSelectedId, false);
    shownSelectedId = selectedId;
    if (selectedId !== null) paint(selectedId, true);
  }

  function showUser(position: LatLon): void {
    if (userMarker) {
      userMarker.setLatLng([position.lat, position.lon]);
      return;
    }

    userMarker = L.marker([position.lat, position.lon], {
      icon: userIcon,
      alt: "Your position",
      title: "Your position",
      // Not a result: it must not be tappable, focusable, or in any other way
      // behave like something you could get directions to.
      interactive: false,
      keyboard: false,
    }).addTo(map);
  }

  /**
   * Point the map at the results — once.
   *
   * Every later render leaves the viewport exactly where it is. A GPS tick
   * arrives every second or so, and re-centring on each one would drag the map
   * out from under a user who had panned somewhere to look at it.
   */
  function frameOnce(spots: DogSpot[], position: LatLon): void {
    if (framed) return;

    const size = map.getSize();
    if (size.x <= 0 || size.y <= 0) {
      // The container has not been laid out yet — a fit computed against a
      // zero-sized viewport is meaningless. Centre on the user and try again
      // on a later render, once there is something to fit against.
      map.setView([position.lat, position.lon], NEARBY_ZOOM);
      return;
    }

    framed = true;

    if (spots.length === 0) {
      map.setView([position.lat, position.lon], NEARBY_ZOOM);
      return;
    }

    // The user is always in frame: a map of dog parks that does not show where
    // the user is standing cannot be read as distances.
    const bounds = L.latLngBounds([[position.lat, position.lon]]);
    for (const spot of spots) {
      bounds.extend([spot.lat, spot.lon]);
    }

    map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: NEARBY_ZOOM });
  }

  return {
    render(spots, position, selectedId) {
      // A detached view is still a live object to whoever is holding it, and
      // Leaflet throws if asked to draw into a map it has already torn down.
      if (destroyed) return;

      showUser(position);

      const plan = planMarkers(pins, spots);

      for (const id of plan.remove) {
        pins.get(id)?.marker.remove();
        pins.delete(id);
      }
      for (const spot of plan.create) {
        addPin(spot, selectedId);
      }
      for (const spot of plan.move) {
        const pin = pins.get(spot.id);
        if (!pin) continue;
        pin.marker.setLatLng([spot.lat, spot.lon]);
        pin.lat = spot.lat;
        pin.lon = spot.lon;
      }

      applySelection(selectedId);
      frameOnce(spots, position);
    },

    destroy() {
      // Lifecycles get re-entrant in practice; a second Leaflet `remove()`
      // would throw.
      if (destroyed) return;
      destroyed = true;

      pins.clear();
      userMarker = null;
      stopTrackingBounds();
      map.remove();
      mapElement.remove();
      container.classList.remove("spot-map");
    },
  };
}
