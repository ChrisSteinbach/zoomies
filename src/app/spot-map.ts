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
import type { DogSpot, DogSpotKind, LatLon } from "./types";
import { worldZoomBounds } from "./map-bounds";
import { OSM_TILE_ATTRIBUTION } from "./attribution";
import { locationPinIcon } from "./map-icons";
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
 * `leaflet/dist/images`, for the reason map-icons.ts gives: Leaflet resolves
 * its default marker images relative to wherever its stylesheet ended up, which
 * survives `npm run dev` and then 404s in a hashed production build.
 *
 * The you-are-here marker is tour-guide's red pin (map-icons.ts) — the same
 * pin the picker plants, so "where you are" and "where you said you are" read
 * as one symbol across the app. The result pins are this module's own smaller
 * teardrops. Telling "a park is there" from "you are here" at a glance,
 * one-handed, outdoors, is the whole job of this map, and the user's pin
 * holds itself apart on every axis it has: red against the layers' green and
 * blue, a size up, drop-shadowed, a different silhouette, and the one marker
 * that ignores taps.
 */
const PIN_PATH =
  "M12 0C5.37 0 0 5.37 0 12c0 9 12 22 12 22s12-13 12-22C24 5.37 18.63 0 12 0z";

/**
 * A pin per layer, told apart by colour: the app's green for a dog park, a
 * deep water blue for a bathing spot.
 *
 * The two layers are one merged answer to "what is around me" (compose-app.ts)
 * and the map is where they are hardest to keep apart — a list row can spell
 * out which it is, a pin has one glance to do it in. That matters more here
 * than it would for two flavours of the same thing: a bathing spot carries
 * caveats a dog park does not (docs/spec.md §4.5.3), and the pin is what sends
 * someone to open the row and read them.
 *
 * The blue is deliberately dark and green-leaning: the layers have to hold
 * apart from each other at a glance, and neither may drift toward the red
 * that means "you are here".
 */
const PIN_COLOURS: Record<DogSpotKind, { pin: string; selected: string }> = {
  dog_park: { pin: "#1a6b3c", selected: "#12522e" },
  bathing_spot: { pin: "#0f5f7a", selected: "#0b4557" },
};

/** The extra class a bathing pin carries, so the stylesheet can treat it as
 *  its own thing. A park pin keeps `spot-map-pin` alone. */
const BATHING_PIN_CLASS = "spot-map-pin-bathing";

function pinSvg(fill: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 34">' +
    `<path d="${PIN_PATH}" fill="${fill}"/>` +
    '<circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>'
  );
}

/** The selected pin: bigger, darker, ringed and outlined in white. Selection
 *  reads as "more of the same colour", exactly as it does in the list — and as
 *  the same treatment whichever layer the spot came from, because selection
 *  means one thing here. */
function selectedPinSvg(fill: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 36">' +
    `<path d="${PIN_PATH}" fill="${fill}" stroke="#fff" stroke-width="2"/>` +
    '<circle cx="12" cy="12" r="6" fill="#fff"/>' +
    `<circle cx="12" cy="12" r="2.75" fill="${fill}"/></svg>`
  );
}

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

/** Both icons for one layer. Built once per kind at module load — four small
 *  data URIs, reused by every marker rather than re-encoded per render. */
function iconsFor(kind: DogSpotKind): { pin: L.Icon; selected: L.Icon } {
  const colours = PIN_COLOURS[kind];
  const kindClass = kind === "bathing_spot" ? ` ${BATHING_PIN_CLASS}` : "";

  // The teardrops are anchored on their point, which is the spot.
  return {
    pin: svgIcon(
      pinSvg(colours.pin),
      [24, 34],
      [12, 34],
      `spot-map-pin${kindClass}`,
    ),
    selected: svgIcon(
      selectedPinSvg(colours.selected),
      [30, 42],
      [15, 42],
      `spot-map-pin spot-map-pin-selected${kindClass}`,
    ),
  };
}

const SPOT_ICONS: Record<DogSpotKind, { pin: L.Icon; selected: L.Icon }> = {
  dog_park: iconsFor("dog_park"),
  bathing_spot: iconsFor("bathing_spot"),
};

/** The user's marker: the red pin, wearing the class the stylesheet uses to
 *  keep it untappable. Built once, like the spot icons above. */
const userIcon = locationPinIcon("spot-map-you");

/** The icon a spot of this kind is drawn with, selected or not. */
function iconFor(kind: DogSpotKind, selected: boolean): L.Icon {
  const icons = SPOT_ICONS[kind];
  return selected ? icons.selected : icons.pin;
}

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
  /**
   * Point the viewport at a new search origin.
   *
   * The one sanctioned exception to "the viewport belongs to the user"
   * (see {@link frameOnce}): the user has just said "look there" — picked a
   * spot, or asked to follow the device again from somewhere else — and
   * centring on it is the looking. Ordinary movement must never come
   * through here.
   */
  frame(position: LatLon): void;
  /** Tears the map down and gives the container back as it was found. Safe to
   *  call more than once. */
  destroy(): void;
}

/** What we need to remember about a pin already on the map: the marker itself,
 *  where it is — the position is what decides whether it can be reused as is —
 *  and which layer it belongs to, because repainting it for a selection change
 *  has only the id to go on. Structurally a {@link LatLon}, so
 *  {@link planMarkers} reads it directly. */
interface PlacedPin extends LatLon {
  marker: L.Marker;
  kind: DogSpotKind;
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
      icon: iconFor(spot.kind, selected),
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
    pins.set(spot.id, {
      marker,
      lat: spot.lat,
      lon: spot.lon,
      kind: spot.kind,
    });
  }

  function paint(id: string, selected: boolean): void {
    const pin = pins.get(id);
    if (!pin) return;

    pin.marker.setIcon(iconFor(pin.kind, selected));
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
   * out from under a user who had panned somewhere to look at it. The one way
   * to move it again is {@link SpotMapHandle.frame}, which only a deliberate
   * reposition reaches.
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

    frame(position) {
      if (destroyed) return;

      map.setView([position.lat, position.lon], NEARBY_ZOOM);
      // The frame is spent: from here the viewport belongs to the user again,
      // exactly as after frameOnce.
      framed = true;
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
