// @vitest-environment jsdom
//
// These run against the real Leaflet rather than a stand-in, for the reason
// map-picker.test.ts gives: a mocked Leaflet could only report which methods
// were called, not what the user would end up looking at.
//
// jsdom lays nothing out, so every element reports zero size — and a map with
// no size cannot place anything, because Leaflet's projection arithmetic
// divides by the viewport. Giving elements a phone-shaped size for the whole
// file is what buys the tests below that assert *where* a marker ended up.
// What is still not testable here is how any of it looks: whether a pin reads
// as a pin at arm's length, and whether the "you are here" dot is
// distinguishable from a result, are browser checks.

import { createSpotMap, planMarkers } from "./spot-map";
import type { DogSpot, LatLon } from "./types";

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  value: 390,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  value: 640,
});

/** Central Stockholm — the phase-1 validation ground (docs/spec.md §10). */
const SLUSSEN: LatLon = { lat: 59.3193, lon: 18.0715 };

function park(overrides: Partial<DogSpot> & Pick<DogSpot, "id">): DogSpot {
  return {
    kind: "dog_park",
    lat: 59.3193,
    lon: 18.0715,
    tags: {},
    provenance: "designated",
    ...overrides,
  };
}

// Real Stockholm parks, so these are distances that actually exist.
const BJORNS = park({
  id: "way/58082448",
  name: "Björns Trädgårds hundrastgård",
  lat: 59.3156731,
  lon: 18.0736705,
});

const MONTELIUS = park({
  id: "node/13245355311",
  name: "Monteliusvägens hundrastgård",
  lat: 59.3207873,
  lon: 18.0596507,
});

const VANADIS = park({
  id: "way/703298765",
  name: "Category:Vanadislundens hundrastgård",
  lat: 59.348179,
  lon: 18.0556013,
});

/** The other layer, which shares this map with the parks. */
const SMEDSUDDS: DogSpot = {
  id: "node/4001",
  kind: "bathing_spot",
  name: "Smedsuddsbadets hundbad",
  lat: 59.3245,
  lon: 18.0271,
  tags: {},
  provenance: "designated",
};

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

/** The result pins, in the order Leaflet put them in the DOM. */
function pins(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll<HTMLImageElement>(".spot-map-pin")];
}

/** A pin addressed the way a screen reader would find it: by its name. */
function pinNamed(container: HTMLElement, name: string): HTMLImageElement {
  return container.querySelector<HTMLImageElement>(
    `.spot-map-pin[alt="${name}"]`,
  )!;
}

function selectedPins(container: HTMLElement): HTMLImageElement[] {
  return [
    ...container.querySelectorAll<HTMLImageElement>(".spot-map-pin-selected"),
  ];
}

function youAreHere(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll<HTMLImageElement>(".spot-map-you")];
}

function tap(marker: HTMLElement): void {
  marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/**
 * Where Leaflet has put a marker on the map, as something comparable.
 *
 * Leaflet positions markers with a transform where the browser supports 3D
 * transforms and with left/top where it does not — jsdom is the latter — so
 * both are read.
 */
function placedAt(marker: HTMLElement): string {
  const { left, top, transform } = marker.style;
  return `${left}|${top}|${transform}`;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("planMarkers", () => {
  it("adds a pin for a spot that has none", () => {
    const plan = planMarkers(new Map(), [BJORNS]);

    expect(plan.create).toEqual([BJORNS]);
    expect(plan.move).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("has nothing to do when the same spots come back unchanged", () => {
    const placed = new Map([[BJORNS.id, { lat: BJORNS.lat, lon: BJORNS.lon }]]);

    const plan = planMarkers(placed, [BJORNS]);

    // The GPS-tick case: re-rendering the results the map is already showing
    // must not touch a single marker.
    expect(plan).toEqual({ create: [], move: [], remove: [] });
  });

  it("moves the pin of a spot whose position has shifted", () => {
    const placed = new Map([[BJORNS.id, { lat: 59.3, lon: 18.07 }]]);

    const plan = planMarkers(placed, [BJORNS]);

    expect(plan.move).toEqual([BJORNS]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("drops the pin of a spot that is no longer a result", () => {
    const placed = new Map([[BJORNS.id, { lat: BJORNS.lat, lon: BJORNS.lon }]]);

    const plan = planMarkers(placed, []);

    expect(plan.remove).toEqual([BJORNS.id]);
  });

  it("keeps what survives a new result set and only touches the rest", () => {
    const placed = new Map([
      [BJORNS.id, { lat: BJORNS.lat, lon: BJORNS.lon }],
      [MONTELIUS.id, { lat: MONTELIUS.lat, lon: MONTELIUS.lon }],
    ]);

    const plan = planMarkers(placed, [BJORNS, VANADIS]);

    expect(plan.create).toEqual([VANADIS]);
    expect(plan.remove).toEqual([MONTELIUS.id]);
    expect(plan.move).toEqual([]);
  });
});

describe("createSpotMap", () => {
  it("credits OpenStreetMap on the map itself", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    const attribution = container.querySelector(
      ".leaflet-control-attribution",
    )!;
    expect(attribution.textContent).toContain("OpenStreetMap");
    expect(
      attribution.querySelector('a[href*="openstreetmap.org/copyright"]'),
    ).not.toBeNull();

    map.destroy();
  });

  it("keeps the credit clear of the sheet that covers the map's foot", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    // Leaflet's default corner is the bottom right, and that is precisely
    // where the result list sits on a phone. A covered credit is a covered
    // credit (docs/spec.md §4.1).
    expect(
      container.querySelector(
        ".leaflet-top.leaflet-right .leaflet-control-attribution",
      ),
    ).not.toBeNull();

    map.destroy();
  });

  it("shows a pin per result and one marker for the user", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);

    expect(pins(container)).toHaveLength(2);
    expect(youAreHere(container)).toHaveLength(1);

    map.destroy();
  });

  it("draws the user's position as something that is not a result", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS], SLUSSEN, null);

    // Different image, and not one of the pins: standing where you are must
    // never be mistakable for somewhere to walk to.
    const [you] = youAreHere(container);
    const [pin] = pins(container);
    expect(you.src).not.toBe(pin.src);
    expect(pins(container)).not.toContain(you);

    map.destroy();
  });

  it("names each pin the way the list names it", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, park({ id: "node/1" })], SLUSSEN, null);

    expect(pins(container).map((pin) => pin.alt)).toEqual([
      "Björns Trädgårds hundrastgård",
      "Unnamed dog park",
    ]);

    map.destroy();
  });

  it("draws a bathing spot as something other than a park", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, SMEDSUDDS], SLUSSEN, null);

    // The two layers are one merged answer, and the map is where they are
    // hardest to tell apart: a pin has one glance to say which it is, and a
    // bathing spot carries caveats a dog park does not.
    const parkPin = pinNamed(container, "Björns Trädgårds hundrastgård");
    const bathingPin = pinNamed(container, "Smedsuddsbadets hundbad");
    expect(bathingPin.classList).toContain("spot-map-pin-bathing");
    expect(parkPin.classList).not.toContain("spot-map-pin-bathing");
    expect(bathingPin.src).not.toBe(parkPin.src);

    map.destroy();
  });

  it("keeps a bathing pin its own colour once selected", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, SMEDSUDDS], SLUSSEN, null);
    const parkSrc = pinNamed(container, "Björns Trädgårds hundrastgård").src;
    map.render([BJORNS, SMEDSUDDS], SLUSSEN, SMEDSUDDS.id);

    // Selection is "more of the same colour", not "become a park".
    const selected = pinNamed(container, "Smedsuddsbadets hundbad");
    expect(selected.classList).toContain("spot-map-pin-selected");
    expect(selected.classList).toContain("spot-map-pin-bathing");
    expect(selected.src).not.toBe(parkSrc);

    map.destroy();
  });

  it("selects a bathing pin the same way it selects a park", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect });

    map.render([BJORNS, SMEDSUDDS], SLUSSEN, null);
    tap(pinNamed(container, "Smedsuddsbadets hundbad"));

    expect(onSelect).toHaveBeenCalledWith(SMEDSUDDS.id);

    map.destroy();
  });

  it("reports the spot behind a pin when it is tapped", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);
    tap(pinNamed(container, "Monteliusvägens hundrastgård"));

    expect(onSelect).toHaveBeenCalledWith(MONTELIUS.id);

    map.destroy();
  });

  it("clears the selection when the selected pin is tapped again", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    tap(pinNamed(container, "Björns Trädgårds hundrastgård"));

    // The same toggle the list rows use, so a tap means the same thing in
    // either view.
    expect(onSelect).toHaveBeenCalledWith(null);

    map.destroy();
  });

  it("highlights the pin a selection made elsewhere points at", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    // What a tap on the list row arrives as: the same render, with an id.
    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);

    expect(selectedPins(container).map((pin) => pin.alt)).toEqual([
      "Monteliusvägens hundrastgård",
    ]);

    map.destroy();
  });

  it("moves the highlight when the selection moves", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);
    map.render([BJORNS, MONTELIUS], SLUSSEN, BJORNS.id);

    expect(selectedPins(container).map((pin) => pin.alt)).toEqual([
      "Björns Trädgårds hundrastgård",
    ]);

    map.destroy();
  });

  it("leaves no pin highlighted once the selection is cleared", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);
    map.render([BJORNS, MONTELIUS], SLUSSEN, null);

    expect(selectedPins(container)).toHaveLength(0);
    expect(pins(container)).toHaveLength(2);

    map.destroy();
  });

  it("reuses the pins it already has when the results have not changed", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);
    const before = pins(container);

    // A GPS tick: same results, a step down the street.
    map.render([BJORNS, MONTELIUS], { lat: 59.3195, lon: 18.0718 }, null);

    // The very same elements, not replacements — a map rebuilt under the
    // user's finger loses their tap, their focus and their place.
    expect(pins(container)).toEqual(before);

    map.destroy();
  });

  it("frames the map on the results after the first render", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS], SLUSSEN, null);

    // BJORNS is a few hundred metres from SLUSSEN — framed to the results,
    // that is a wide, visible gap on screen. Left at the opening world view
    // (WORLD_CENTRE/WORLD_ZOOM, both far too zoomed out to tell them apart),
    // the two markers would land on the same pixel.
    const you = youAreHere(container)[0];
    const pin = pinNamed(container, BJORNS.name!);
    const dx = parseFloat(you.style.left) - parseFloat(pin.style.left);
    const dy = parseFloat(you.style.top) - parseFloat(pin.style.top);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(50);

    map.destroy();
  });

  it("centres on the user when there are no results to frame", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([], SLUSSEN, null);

    // Centred on the user, the you-are-here marker lands exactly on the
    // container's midpoint (390×640, stubbed above) at any zoom, because its
    // own coordinates are the view's centre. Left at the opening world view,
    // SLUSSEN is nowhere near WORLD_CENTRE and the marker lands far off it.
    const you = youAreHere(container)[0];
    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    map.destroy();
  });

  it("follows the user without dragging the map along", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS], SLUSSEN, null);
    const pinBefore = placedAt(pinNamed(container, BJORNS.name!));
    const youBefore = placedAt(youAreHere(container)[0]);

    map.render([BJORNS], { lat: 59.3205, lon: 18.0729 }, null);

    // The dot moves because the user did. The pin does not, which means the
    // viewport did not: a map that re-centred every second would be unusable
    // for the one thing a map is for — looking somewhere else.
    expect(placedAt(youAreHere(container)[0])).not.toBe(youBefore);
    expect(placedAt(pinNamed(container, BJORNS.name!))).toBe(pinBefore);

    map.destroy();
  });

  it("goes where a deliberate reposition points it", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS], SLUSSEN, null);
    const before = placedAt(youAreHere(container)[0]);

    // The user picked a spot up in Vanadislunden. Centred on it, the marker
    // lands exactly on the container's midpoint (390×640, stubbed above) —
    // which the old Slussen viewport could not produce for a position three
    // kilometres away.
    const origin = { lat: VANADIS.lat, lon: VANADIS.lon };
    map.frame(origin);
    map.render([BJORNS], origin, null);

    const you = youAreHere(container)[0];
    expect(placedAt(you)).not.toBe(before);
    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    map.destroy();
  });

  it("takes down the pins of results that are gone", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);
    map.render([VANADIS], SLUSSEN, null);

    expect(pins(container).map((pin) => pin.alt)).toEqual([
      "Category:Vanadislundens hundrastgård",
    ]);

    map.destroy();
  });

  it("hands the container back the way it found it", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });
    map.render([BJORNS], SLUSSEN, null);

    map.destroy();

    expect(container.children).toHaveLength(0);
    expect(container.className).toBe("");
  });

  it("ignores a render that arrives after it was destroyed", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.destroy();

    expect(() => map.render([BJORNS], SLUSSEN, null)).not.toThrow();
  });

  it("ignores a frame that arrives after it was destroyed", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.destroy();

    expect(() => map.frame(SLUSSEN)).not.toThrow();
  });

  it("survives being destroyed twice", () => {
    const container = mount();
    const map = createSpotMap(container, { onSelect: vi.fn() });

    map.destroy();

    expect(() => map.destroy()).not.toThrow();
  });
});
