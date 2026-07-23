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
import { formatDistance } from "./format";
import { haversineMeters } from "./geo";

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);

    expect(pins(container)).toHaveLength(2);
    expect(youAreHere(container)).toHaveLength(1);

    map.destroy();
  });

  it("draws the user's position as something that is not a result", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, park({ id: "node/1" })], SLUSSEN, null);

    expect(pins(container).map((pin) => pin.alt)).toEqual([
      "Björns Trädgårds hundrastgård",
      "Unnamed dog park",
    ]);

    map.destroy();
  });

  it("draws a bathing spot as something other than a park", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS, SMEDSUDDS], SLUSSEN, null);
    tap(pinNamed(container, "Smedsuddsbadets hundbad"));

    expect(onSelect).toHaveBeenCalledWith(SMEDSUDDS.id);

    map.destroy();
  });

  it("reports the spot behind a pin when it is tapped", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);
    tap(pinNamed(container, "Monteliusvägens hundrastgård"));

    expect(onSelect).toHaveBeenCalledWith(MONTELIUS.id);

    map.destroy();
  });

  it("clears the selection when the selected pin is tapped again", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    tap(pinNamed(container, "Björns Trädgårds hundrastgård"));

    // The same toggle the list rows use, so a tap means the same thing in
    // either view. Exactly once: the open callout must not add a dismissal
    // of its own to the same tap, or the two reports race each other and
    // the toggle re-selects instead of clearing.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);

    map.destroy();
  });

  it("clears the selection when the bare map is tapped", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    tap(container.querySelector<HTMLElement>(".leaflet-container")!);

    // Tapping past the pins is walking away from the answer: the selection
    // clears, and the callout goes with it.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);

    map.destroy();
  });

  it("lets a tap on the empty map fall through when nothing is selected", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS], SLUSSEN, null);
    tap(container.querySelector<HTMLElement>(".leaflet-container")!);

    // With nothing selected there is nothing to walk away from — reporting
    // null here would send the machine no-op events on every map tap.
    expect(onSelect).not.toHaveBeenCalled();

    map.destroy();
  });

  it("highlights the pin a selection made elsewhere points at", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    // What a tap on the list row arrives as: the same render, with an id.
    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);

    expect(selectedPins(container).map((pin) => pin.alt)).toEqual([
      "Monteliusvägens hundrastgård",
    ]);

    map.destroy();
  });

  it("moves the highlight when the selection moves", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);
    map.render([BJORNS, MONTELIUS], SLUSSEN, BJORNS.id);

    expect(selectedPins(container).map((pin) => pin.alt)).toEqual([
      "Björns Trädgårds hundrastgård",
    ]);

    map.destroy();
  });

  it("leaves no pin highlighted once the selection is cleared", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);
    map.render([BJORNS, MONTELIUS], SLUSSEN, null);

    expect(selectedPins(container)).toHaveLength(0);
    expect(pins(container)).toHaveLength(2);

    map.destroy();
  });

  it("reuses the pins it already has when the results have not changed", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

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

  it("frames the results when they arrive after an empty searching render", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    // The searching render: no results yet, so the opening frame only gets as
    // far as centring on the user (see "centres on the user when there are
    // no results to frame").
    map.render([], SLUSSEN, null);
    const you = youAreHere(container)[0];
    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    // The answer lands a render later, with the opening frame still unspent —
    // this is the bug itself. It used to be spent on the render above, so the
    // fit below never got the chance to run.
    map.render([VANADIS], SLUSSEN, null);

    // VANADIS sits a few kilometres due north of SLUSSEN, so a fit that
    // includes it pulls the view north and off the user's midpoint.
    expect(you.style.top).not.toBe("320px");

    // And the fit reaches all the way to VANADIS: left at the user-centred
    // view above, its pin would sit far above the visible container instead.
    const pin = pinNamed(container, VANADIS.name!);
    expect(parseFloat(pin.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(pin.style.left)).toBeLessThanOrEqual(390);
    expect(parseFloat(pin.style.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(pin.style.top)).toBeLessThanOrEqual(640);

    map.destroy();
  });

  it("keeps the viewport still while the search runs and the user walks", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([], SLUSSEN, null);
    const you = youAreHere(container)[0];
    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    // A GPS tick ~150m on, the same step "follows the user without dragging
    // the map along" uses — still nothing back from the search.
    map.render([], { lat: 59.3205, lon: 18.0729 }, null);

    // The dot followed the user rather than staying put: a second centring
    // would have put it right back on the midpoint it started at.
    expect(you.style.left).not.toBe("195px");
    expect(you.style.top).not.toBe("320px");

    map.destroy();
  });

  it("leaves a viewport the user has taken alone when the results arrive", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([], SLUSSEN, null);
    const beforeZoom = placedAt(youAreHere(container)[0]);

    // The user takes the map mid-search: a double-click zoom, Leaflet's own
    // gesture rather than anything this module drives, dispatched on the
    // element Leaflet was mounted on. jsdom has no 3D-transform support, so
    // Leaflet treats the zoom as one it cannot animate and applies it
    // synchronously instead of queuing a CSS transition this test would
    // never see finish.
    const canvas = container.querySelector(".spot-map-canvas")!;
    canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    // The gesture must actually have reached Leaflet, or the rest of this
    // test asserts nothing.
    const afterZoom = placedAt(youAreHere(container)[0]);
    expect(afterZoom).not.toBe(beforeZoom);

    // The results land after the user has already taken the viewport: the
    // movestart the zoom fired stood the opening frame down, so this render
    // must leave the view exactly where the user put it.
    map.render([VANADIS], SLUSSEN, null);

    expect(placedAt(youAreHere(container)[0])).toBe(afterZoom);

    map.destroy();
  });

  it("a deliberate frame is not re-spent by results that arrive later", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    // The user picked a spot up in Vanadislunden — the same reposition "goes
    // where a deliberate reposition points it" exercises.
    const origin = { lat: VANADIS.lat, lon: VANADIS.lon };
    map.frame(origin);
    map.render([], origin, null);

    const you = youAreHere(container)[0];
    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    // BJORNS is the picked neighbourhood's own answer, arriving a render
    // later — a fit to include it (BJORNS sits a few km south) would move
    // the dot off the midpoint. The picked point stays the thing being
    // looked at (state-machine.ts's position-picked comment): frame() has
    // already spent the opening frame, and results arriving afterwards must
    // not spend it again.
    map.render([BJORNS], origin, null);

    expect(you.style.left).toBe("195px");
    expect(you.style.top).toBe("320px");

    map.destroy();
  });

  it("takes down the pins of results that are gone", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, MONTELIUS], SLUSSEN, null);
    map.render([VANADIS], SLUSSEN, null);

    expect(pins(container).map((pin) => pin.alt)).toEqual([
      "Category:Vanadislundens hundrastgård",
    ]);

    map.destroy();
  });

  it("hands the container back the way it found it", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });
    map.render([BJORNS], SLUSSEN, null);

    map.destroy();

    expect(container.children).toHaveLength(0);
    expect(container.className).toBe("");
  });

  it("ignores a render that arrives after it was destroyed", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.destroy();

    expect(() => map.render([BJORNS], SLUSSEN, null)).not.toThrow();
  });

  it("ignores a frame that arrives after it was destroyed", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.destroy();

    expect(() => map.frame(SLUSSEN)).not.toThrow();
  });

  it("survives being destroyed twice", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.destroy();

    expect(() => map.destroy()).not.toThrow();
  });
});

describe("the selection callout", () => {
  /** The callout's own root element, if the selection currently has one open. */
  function callout(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(".spot-map-callout");
  }

  it("callout appears with the spot's name and distance when a render selects it", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS, MONTELIUS], SLUSSEN, BJORNS.id);

    expect(
      callout(container)?.querySelector(".spot-map-callout-name")?.textContent,
    ).toBe(BJORNS.name);
    expect(
      callout(container)?.querySelector(".spot-map-callout-distance")
        ?.textContent,
    ).toBe(formatDistance(haversineMeters(SLUSSEN, BJORNS)));

    map.destroy();
  });

  it("the callout's button reports a directions request for the spot", () => {
    const container = mount();
    const onDirections = vi.fn<(id: string) => void>();
    const map = createSpotMap(container, { onSelect: vi.fn(), onDirections });

    map.render([BJORNS, MONTELIUS], SLUSSEN, MONTELIUS.id);
    const button = callout(container)!.querySelector<HTMLButtonElement>(
      ".spot-map-callout-directions",
    )!;
    expect(button.getAttribute("aria-label")).toBe(
      `Open in maps: ${MONTELIUS.name}`,
    );
    tap(button);

    expect(onDirections).toHaveBeenCalledWith(MONTELIUS.id);

    map.destroy();
  });

  it("the callout goes away when the selection clears", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    map.render([BJORNS], SLUSSEN, null);

    expect(callout(container)).toBeNull();

    map.destroy();
  });

  it("dismissing the callout with its close button clears the selection", () => {
    const container = mount();
    const onSelect = vi.fn<(id: string | null) => void>();
    const map = createSpotMap(container, { onSelect, onDirections: vi.fn() });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    tap(container.querySelector(".leaflet-popup-close-button")!);

    // The dismissal is reported exactly once — the callout's own close and
    // the machine's selection must not fall out of step with each other.
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onSelect).toHaveBeenCalledTimes(1);

    map.destroy();
  });

  it("a re-render that changes nothing leaves the callout DOM alone", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    map.render([BJORNS], SLUSSEN, BJORNS.id);
    const before = callout(container);

    // Same spots, same position, same selection — the GPS-tick case.
    map.render([BJORNS], SLUSSEN, BJORNS.id);

    expect(callout(container)).toBe(before);

    map.destroy();
  });

  it("a bathing spot's callout carries the badge, the provenance line and the seasonal caveat", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
      // Inside the Stockholm beach ban's 1 Jun – 31 Aug window.
      today: new Date(2026, 6, 15),
    });
    const banned: DogSpot = {
      id: "way/7001",
      kind: "bathing_spot",
      name: "Långholmens strandbad",
      lat: 59.3208,
      lon: 18.0284,
      tags: {},
      provenance: "permitted",
      seasonal: {
        kind: "ban",
        from: { month: 6, day: 1 },
        to: { month: 8, day: 31 },
      },
    };

    map.render([banned], SLUSSEN, banned.id);

    expect(
      callout(container)?.querySelector(".spot-map-callout-kind")?.textContent,
    ).toBe("Bathing");
    expect(
      callout(container)?.querySelector(".spot-map-callout-provenance")
        ?.textContent,
    ).toBe("Dogs allowed");
    expect(
      callout(container)?.querySelector(".spot-map-callout-caveat")
        ?.textContent,
    ).toBe("Dogs banned now (1 Jun – 31 Aug)");
    // The card is marked, not just the caption — the one thing here that can
    // cost the reader a fine must not be something a hurried glance misses.
    expect(callout(container)?.getAttribute("data-banned")).toBe("true");

    map.destroy();
  });

  it("a bathing spot with no seasonal rule still says to verify signage on site", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
      today: new Date(2026, 0, 15),
    });
    const spot: DogSpot = {
      id: "way/7002",
      kind: "bathing_spot",
      name: "Tantobadet",
      lat: 59.3208,
      lon: 18.0284,
      tags: {},
      provenance: "designated",
    };

    map.render([spot], SLUSSEN, spot.id);

    expect(
      callout(container)?.querySelector(".spot-map-callout-caveat")
        ?.textContent,
    ).toBe("Verify signage on site");

    map.destroy();
  });
});

describe("frameSpot", () => {
  it("leaves the viewport alone when the spot is already in view", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });

    // The opening fit already puts BJORNS comfortably inside the padded
    // viewport (see "frames the map on the results after the first render").
    map.render([BJORNS], SLUSSEN, null);
    const pinBefore = placedAt(pinNamed(container, BJORNS.name!));
    const youBefore = placedAt(youAreHere(container)[0]);

    map.frameSpot({ lat: BJORNS.lat, lon: BJORNS.lon }, SLUSSEN);

    expect(placedAt(pinNamed(container, BJORNS.name!))).toBe(pinBefore);
    expect(placedAt(youAreHere(container)[0])).toBe(youBefore);

    map.destroy();
  });

  it("brings an off-screen spot and the user into view", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });
    // ~0.09° of longitude is ~5 km at Stockholm's latitude — far outside the
    // 390px stubbed viewport once the map sits at NEARBY_ZOOM on SLUSSEN.
    const FAR = park({
      id: "way/8001",
      name: "Fjärran hundrastgård",
      lat: SLUSSEN.lat,
      lon: SLUSSEN.lon + 0.09,
    });

    map.render([FAR], SLUSSEN, null);
    // A deliberate reposition back onto the user alone, discarding whatever
    // the opening fit did — this is what puts FAR's existing pin off-screen.
    map.frame(SLUSSEN);

    map.frameSpot({ lat: FAR.lat, lon: FAR.lon }, SLUSSEN);

    const pin = pinNamed(container, FAR.name!);
    const you = youAreHere(container)[0];
    for (const marker of [pin, you]) {
      expect(parseFloat(marker.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(marker.style.left)).toBeLessThanOrEqual(390);
      expect(parseFloat(marker.style.top)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(marker.style.top)).toBeLessThanOrEqual(640);
    }

    map.destroy();
  });

  it("treats the obscured right edge as out of view", () => {
    const container = mount();
    const map = createSpotMap(container, {
      onSelect: vi.fn(),
      onDirections: vi.fn(),
    });
    // A few hundred metres east of SLUSSEN: close enough that, framed on the
    // user alone at NEARBY_ZOOM, it lands inside the 390px viewport — but
    // within the rightmost 200px a caller can say a drawer covers.
    const NEARBY = park({
      id: "way/8002",
      name: "Närliggande hundrastgård",
      lat: SLUSSEN.lat,
      lon: SLUSSEN.lon + 0.005,
    });

    map.frame(SLUSSEN);
    map.render([NEARBY], SLUSSEN, null);

    const before = parseFloat(pinNamed(container, NEARBY.name!).style.left);
    expect(before).toBeGreaterThan(190); // inside the rightmost 200px of 390

    map.frameSpot({ lat: NEARBY.lat, lon: NEARBY.lon }, SLUSSEN, 200);

    const after = parseFloat(pinNamed(container, NEARBY.name!).style.left);
    expect(after).toBeLessThan(190);

    map.destroy();
  });
});
