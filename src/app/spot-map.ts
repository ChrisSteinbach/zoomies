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
import {
  BATHING_BADGE,
  PROVENANCE_LABELS,
  seasonalCaption,
  spotLabel,
} from "./spot-list";
import { haversineMeters } from "./geo";
import { formatDistance } from "./format";

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

/** Lifts the callout's tip clear of the selected pin it is anchored to — the
 *  selected teardrop stands 42px on its point, and the callout should sit on
 *  its head rather than over it. */
const CALLOUT_OFFSET: [number, number] = [0, -38];

/** Narrower than Leaflet's 300px default: the callout carries a name, a
 *  distance and a button, and on a 375px screen it must not be the thing
 *  that hides the map it is annotating. */
const CALLOUT_MAX_WIDTH = 240;

/** What a frame must clear above the selected pin's tip beyond the card
 *  itself: the offset lifting the card off the pin, the popup's ~20px tip
 *  bridging that gap, and a breath of margin to the viewport edge. */
const CALLOUT_HEADROOM = -CALLOUT_OFFSET[1] + 28;

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
   * row does in the list. Dismissing the callout (its ×, Esc, a tap on the
   * bare map) reports `null` through here too: the callout is the selection
   * made visible, so closing it *is* deselecting.
   */
  onSelect: (id: string | null) => void;
  /**
   * The callout's "open in maps" button was tapped. The same shape as the
   * list's — this view builds no URL and reads no `navigator`; what
   * directions mean is decided where it always was.
   */
  onDirections: (id: string) => void;
  /**
   * The date the callout's seasonal caption is decided against. Defaults to
   * the day of each render — injectable for the reason SpotListOptions gives:
   * "banned *now*" is a claim about the clock, and a test must not read the
   * real one.
   */
  today?: Date;
  /**
   * How many pixels of the map's right edge are currently covered by chrome
   * — the results drawer, in practice. Read at the moment of every
   * programmatic reposition, so each aims at the visible part of the
   * viewport rather than the whole container. The caller reports zero when
   * the cover spans the whole map (there is no visible sliver to aim for);
   * the view re-guards against that anyway. Defaults to "nothing covered".
   */
  obscuredRight?: () => number;
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
   * centring on it is the looking. Centring aims at the visible part of the
   * viewport when chrome covers the map's right edge. Ordinary movement
   * must never come through here.
   */
  frame(position: LatLon): void;
  /**
   * Bring a selected spot into view, with the user's position alongside for
   * scale — the other sanctioned reposition, carrying the `frame-spot`
   * effect.
   *
   * Gentler than {@link frame}: a spot already comfortably in view moves
   * nothing, so tapping a visible pin never disturbs a viewport the user has
   * set. Only when the spot is out of view (or under whatever the
   * creation-time {@link SpotMapOptions.obscuredRight} callback says is
   * covering the map's right edge — a desktop drawer) does the map
   * reposition, fitting spot and user together so the answer reads as
   * "there, relative to you".
   */
  frameSpot(spot: LatLon, user: LatLon | null): void;
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
  { onSelect, onDirections, today, obscuredRight = () => 0 }: SpotMapOptions,
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
  /** Whether the opening frame has been spent — pointed at the first results,
   *  overtaken by a deliberate {@link SpotMapHandle.frame}, or claimed by the
   *  user's own hand on the map. Once it has, the viewport belongs to the
   *  user. */
  let framed = false;
  /** Whether the map has pointed itself at the user while the first answer
   *  was still on its way. Done once: a search can outlive several renders,
   *  and re-centring on each would drag the map out from under a user who
   *  had started looking around. */
  let centredOnUser = false;
  /** True while this module is itself moving the map, so the claim listener
   *  below can tell its own repositions from the user's hand. */
  let repositioning = false;
  let destroyed = false;

  /** Every programmatic move this module makes goes through here, without
   *  exception — the fence is what lets any movement outside it be read as
   *  the user's. */
  function reposition(move: () => void): void {
    repositioning = true;
    try {
      move();
    } finally {
      repositioning = false;
    }
  }

  /** How much of the viewport's right edge is covered right now. A cover as
   *  wide as the map means there is no visible sliver to aim for — the
   *  caller is expected to have moved a full-width cover aside (the phone
   *  drawer closes on select); failing that, the full viewport is the only
   *  honest target left. */
  function visibleInset(size: L.Point): number {
    const covered = obscuredRight();
    return covered < size.x ? covered : 0;
  }

  /**
   * The centre the map must sit at for `position` to land in the middle of
   * the *visible* (uncovered) width: shifting the centre half the inset east
   * places the target half the inset west of the container's midline — the
   * middle of the uncovered part. A pre-layout zero size yields inset 0 and
   * the plain centre.
   */
  function visibleCentre(position: LatLon, zoom: number): L.LatLng {
    const size = map.getSize();
    const inset = visibleInset(size);
    if (inset === 0) return L.latLng(position.lat, position.lon);
    return map.unproject(
      map.project([position.lat, position.lon], zoom).add([inset / 2, 0]),
      zoom,
    );
  }

  // Any movement this module did not make is the user taking the viewport:
  // from then on it is theirs, and the opening frame — which may still be
  // waiting for the first results — stands down rather than yank the map
  // away from wherever they are looking. Attached *after* the bounds
  // tracker's install() above, whose zoom-floor clamp at creation would
  // otherwise read as a user zoom. (Its resize-time clamp can still slip
  // through — rotating the phone mid-search at the world view — which costs
  // only the opening fit, never a viewport the user has set.)
  map.on("movestart zoomstart", () => {
    if (!repositioning) framed = true;
  });

  /**
   * The callout: one popup, moved from pin to pin as the selection moves.
   *
   * Deliberately *not* bound to any marker — Leaflet's own click-to-open
   * would decide what a tap means without asking the machine, and the
   * selection must stay the one model both surfaces render from. Everything
   * that opens, moves or closes this popup is {@link updateCallout}, working
   * from the state each render hands in.
   */
  const callout = L.popup({
    className: "spot-map-callout-popup",
    offset: CALLOUT_OFFSET,
    maxWidth: CALLOUT_MAX_WIDTH,
    // Leaflet's own close-on-map-click acts on `preclick` — delivered before
    // a tapped marker's click. Left on, tapping the selected pin closed the
    // callout and cleared the selection first, so the marker handler then
    // read "nothing selected" and re-selected: the toggle could never turn
    // off. Dismissal by tapping the bare map is wired explicitly below, on
    // plain `click`, which a marker tap never reaches (markers do not
    // bubble their mouse events to the map).
    closeOnClick: false,
    // Leaflet's auto-pan fires the moment the popup opens — during render,
    // *before* the frame-spot effect runs — and a big enough pan teleports
    // the selected spot into view on its own. The frame that was meant to
    // show spot and user together then judges the spot already visible and
    // stands down: callout neatly in frame, user pin stranded off screen
    // (seen driving the app). Positioning at selection time has exactly one
    // owner, frameSpot; the part of auto-pan worth keeping lives there, in
    // nudgeCalloutIntoView.
    autoPan: false,
  });
  /** Which spot the callout is on, `null` when closed. */
  let calloutSpotId: string | null = null;
  /** What the callout currently says (spot + formatted distance), so the
   *  every-second render rebuilds its DOM only when the words change. */
  let calloutKey: string | null = null;
  /** True while {@link updateCallout} itself is opening, moving or closing
   *  the popup, so the `remove` listener below can tell our own bookkeeping
   *  from the user dismissing it. */
  let syncingCallout = false;

  callout.on("remove", () => {
    // The popup has dismissals of its own — the × and Esc — and each must
    // clear the selection, or the callout falls out of lockstep with the
    // list's highlight. Our own closes are fenced off by the flag, and
    // teardown must not dispatch into an app being destroyed.
    if (syncingCallout || destroyed || calloutSpotId === null) return;
    calloutSpotId = null;
    calloutKey = null;
    onSelect(null);
  });

  // A tap on the bare map walks away from the answer: the selection clears,
  // which closes the callout with it. Only ever fired for the map itself —
  // pins swallow their own taps, and the callout's card does not let clicks
  // through — and only reported when there is a selection to walk away from.
  map.on("click", () => {
    if (shownSelectedId !== null) onSelect(null);
  });

  /**
   * The callout's card: the same three facts a list row leads with — name,
   * distance from where the user is standing, the way into the maps app.
   *
   * A bathing spot's card also carries the row's two disclosure lines, in the
   * row's exact words (imported from spot-list.ts). A card with a directions
   * button is an invitation to go, and it must not read more confident than
   * the list it stands in for (docs/spec.md §4.5.3).
   */
  function buildCallout(spot: DogSpot, meters: number): HTMLElement {
    const label = spotLabel(spot);

    const content = document.createElement("div");
    content.className = "spot-map-callout";

    const name = document.createElement("p");
    name.className = "spot-map-callout-name";
    name.textContent = label;

    if (spot.kind === "bathing_spot") {
      const badge = document.createElement("span");
      badge.className = "spot-map-callout-kind";
      badge.textContent = BATHING_BADGE;
      name.append(" ", badge);
    }

    const distance = document.createElement("p");
    distance.className = "spot-map-callout-distance";
    distance.textContent = formatDistance(meters);

    content.append(name, distance);

    if (spot.kind === "bathing_spot") {
      const provenance = document.createElement("p");
      provenance.className = "spot-map-callout-provenance";
      provenance.textContent = PROVENANCE_LABELS[spot.provenance];

      const caveat = document.createElement("p");
      caveat.className = "spot-map-callout-caveat";
      const seasonal = seasonalCaption(spot, today ?? new Date());
      caveat.textContent = seasonal.text;
      // The card is marked, not just the caption, exactly as the row is: a
      // ban in force is the one thing here that can cost the reader a fine.
      if (seasonal.bannedNow) content.dataset.banned = "true";

      content.append(provenance, caveat);
    }

    const directions = document.createElement("button");
    directions.type = "button";
    directions.className = "spot-map-callout-directions";
    // The name goes in the accessible name for the list's reason: every
    // card's button says the same three words.
    directions.setAttribute("aria-label", `Open in maps: ${label}`);
    directions.textContent = "Open in maps";
    directions.addEventListener("click", () => {
      onDirections(spot.id);
    });

    content.append(directions);
    return content;
  }

  /**
   * Hold the callout to the selection: open on the selected spot, moved when
   * the selection moves, gone when it clears.
   *
   * Called on every render, so it must be cheap when nothing changed: the
   * content is keyed on what it says, and a GPS tick that does not change the
   * formatted distance touches nothing. The anchor is re-asserted each time
   * because a spot's own position can shift between queries (see
   * {@link planMarkers} on moves), and an anchor is too cheap to diff.
   */
  function updateCallout(spot: DogSpot | null, position: LatLon): void {
    syncingCallout = true;
    try {
      if (!spot) {
        calloutSpotId = null;
        calloutKey = null;
        map.closePopup(callout);
        return;
      }

      const meters = haversineMeters(position, spot);
      const key = `${spot.id}\n${formatDistance(meters)}`;
      if (key !== calloutKey) {
        callout.setContent(buildCallout(spot, meters));
        calloutKey = key;
      }

      callout.setLatLng([spot.lat, spot.lon]);
      calloutSpotId = spot.id;
      if (!callout.isOpen()) callout.openOn(map);
    } finally {
      syncingCallout = false;
    }
  }

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
   * Point the map at the results — once, on the first render that has any.
   *
   * The first render with a position is usually the *searching* one: the
   * query is still in flight and there is nothing to fit yet. So the opening
   * frame arrives in two steps — centre on the user while the answer is on
   * its way, then fit user and results together on the first render that
   * carries spots. Only the fit spends the frame; searched-and-found-nothing
   * leaves the centred view as the answer, and a layer switched on later can
   * still be the first thing worth fitting.
   *
   * Every render after the frame is spent leaves the viewport exactly where
   * it is. A GPS tick arrives every second or so, and re-centring on each one
   * would drag the map out from under a user who had panned somewhere to look
   * at it — and the user touching the map before the results land spends the
   * frame the same way (see the movestart listener above), so a slow search
   * never snatches the viewport back. The one way to move it again is
   * {@link SpotMapHandle.frame}, which only a deliberate reposition reaches.
   */
  function frameOnce(spots: DogSpot[], position: LatLon): void {
    if (framed) return;

    const size = map.getSize();
    if (size.x <= 0 || size.y <= 0) {
      // The container has not been laid out yet — a fit computed against a
      // zero-sized viewport is meaningless. Centre on the user and try again
      // on a later render, once there is something to fit against.
      reposition(() => map.setView([position.lat, position.lon], NEARBY_ZOOM));
      return;
    }

    if (spots.length === 0) {
      if (!centredOnUser) {
        centredOnUser = true;
        reposition(() =>
          map.setView(visibleCentre(position, NEARBY_ZOOM), NEARBY_ZOOM),
        );
      }
      return;
    }

    framed = true;

    // The user is always in frame: a map of dog parks that does not show where
    // the user is standing cannot be read as distances.
    const bounds = L.latLngBounds([[position.lat, position.lon]]);
    for (const spot of spots) {
      bounds.extend([spot.lat, spot.lon]);
    }

    // Instant for frameSpot's reason: the centring above starts an animated
    // zoom, and while that is pending an animated fit would be silently
    // swallowed (Map._tryAnimatedZoom returns early) — exactly the fast-answer
    // case a cached or offline dataset makes common.
    //
    // The covered strip is real map the fit must not aim into — the same
    // rule frameSpot applies — so it is padding on top of the ordinary kind.
    reposition(() =>
      map.fitBounds(bounds, {
        paddingTopLeft: FIT_PADDING,
        paddingBottomRight: [
          FIT_PADDING[0] + visibleInset(size),
          FIT_PADDING[1],
        ],
        maxZoom: NEARBY_ZOOM,
        animate: false,
      }),
    );
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
      // The machine has already vouched that a selected id is visible
      // (normalizeSelection), so a miss here is only ever a render older than
      // the state it was called with — closing the callout is right anyway.
      updateCallout(
        selectedId === null
          ? null
          : (spots.find((spot) => spot.id === selectedId) ?? null),
        position,
      );
      frameOnce(spots, position);
    },

    frame(position) {
      if (destroyed) return;

      reposition(() =>
        map.setView(visibleCentre(position, NEARBY_ZOOM), NEARBY_ZOOM),
      );
      // The frame is spent: from here the viewport belongs to the user again,
      // exactly as after frameOnce.
      framed = true;
    },

    frameSpot(spot, user) {
      if (destroyed) return;

      const target = L.latLng(spot.lat, spot.lon);
      const size = map.getSize();

      // Every move below says `animate: false`, deliberately: an animated
      // zoom only completes on a CSS transitionend Leaflet waits for, and
      // while one is pending every further zoom-changing setView is silently
      // swallowed (Map._tryAnimatedZoom returns early). Headless browsers
      // and backgrounded tabs really do sit on that event — driving the app
      // under Playwright, a selection's frame vanished without a trace this
      // way. A deliberate "look there" that lands instantly beats one that
      // sometimes never lands.
      const instant = { animate: false } as const;

      // Pre-layout there is no viewport to test against or fit into: point
      // straight at the spot, as frameOnce's fallback points at the user.
      if (size.x <= 0 || size.y <= 0) {
        framed = true;
        reposition(() => map.setView(target, NEARBY_ZOOM, instant));
        return;
      }

      const inset = visibleInset(size);

      /**
       * The minimal instant pan that brings the open callout's card wholly
       * into the visible part of the viewport, pin and all.
       *
       * The sanctioned remnant of Leaflet's auto-pan (switched off on the
       * popup itself — see its options): when the viewport stays because the
       * pin is already in view, a pin near an edge still wears its card half
       * off screen, and this shifts both inward by exactly the deficit. The
       * card hangs over its anchor — half its width each side, its height
       * plus the tip and offset above — so keeping that rectangle in view
       * can only move the pin further *into* the viewport, never out.
       */
      function nudgeCalloutIntoView(): void {
        const card = callout.isOpen() ? callout.getElement() : undefined;
        if (!card) return;
        const width = card.offsetWidth;
        const height = card.offsetHeight;
        if (width === 0 || height === 0) return;

        const margin = 8;
        const anchor = map.latLngToContainerPoint(target);
        const left = anchor.x - width / 2;
        const right = anchor.x + width / 2;
        const top = anchor.y - height - CALLOUT_HEADROOM;

        // panBy moves the viewport, so content shifts the other way: a
        // positive x here sends the card leftwards.
        let dx = 0;
        if (left < margin) dx = left - margin;
        else if (right > size.x - inset - margin) {
          dx = right - (size.x - inset - margin);
        }
        const dy = top < margin ? top - margin : 0;

        if (dx !== 0 || dy !== 0) {
          reposition(() => map.panBy([dx, dy], { animate: false }));
        }
      }

      // Already comfortably in view — clear of the edges and of whatever
      // covers the right — means there is nothing to look towards, and the
      // viewport belongs to the user (see frameOnce). This is what keeps a
      // tap on a visible pin from yanking away a zoom the user chose. Only
      // the card gets its nudge.
      const point = map.latLngToContainerPoint(target);
      const [padX, padY] = FIT_PADDING;
      if (
        point.x >= padX &&
        point.x <= size.x - inset - padX &&
        point.y >= padY &&
        point.y <= size.y - padY
      ) {
        nudgeCalloutIntoView();
        return;
      }

      framed = true;

      if (!user) {
        reposition(() => map.setView(target, NEARBY_ZOOM, instant));
        nudgeCalloutIntoView();
        return;
      }

      // The callout is part of the answer, so the fit leaves room for the
      // card riding the selected pin — measured live, because its height
      // varies (a bathing card carries two more lines) and nothing else
      // re-adjusts it after the reposition. Unmeasurable (closed, or a test
      // DOM with no layout) means zero, which leaves the plain padding.
      const card = callout.isOpen() ? callout.getElement() : undefined;
      const sidePad = card ? Math.max(padX, card.offsetWidth / 2 + 8) : padX;
      const topPad = card
        ? Math.max(padY, card.offsetHeight + CALLOUT_HEADROOM)
        : padY;

      // Spot and user together: "there, relative to you" is what a selection
      // asks the map for. The asymmetric padding keeps both out from under a
      // desktop drawer as well as off the edges.
      reposition(() =>
        map.fitBounds(L.latLngBounds([target, [user.lat, user.lon]]), {
          paddingTopLeft: [sidePad, topPad],
          paddingBottomRight: [sidePad + inset, padY],
          maxZoom: NEARBY_ZOOM,
          ...instant,
        }),
      );
      // The padding above should have made this a no-op; a maxZoom-bound
      // fit of two very close points is the one case with slack left.
      nudgeCalloutIntoView();
    },

    destroy() {
      // Lifecycles get re-entrant in practice; a second Leaflet `remove()`
      // would throw.
      if (destroyed) return;
      destroyed = true;

      // `map.remove()` below will detach the popup and fire its `remove`
      // event; the flag above already keeps that from dispatching, and
      // unhooking first makes it structural.
      callout.off();
      pins.clear();
      userMarker = null;
      stopTrackingBounds();
      map.remove();
      mapElement.remove();
      container.classList.remove("spot-map");
    },
  };
}
