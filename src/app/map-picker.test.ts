// @vitest-environment jsdom
//
// These run against the real Leaflet rather than a stand-in. jsdom is enough
// for it to build its DOM, route a click through its own hit-testing and tear
// itself down again, and a mocked Leaflet could only report which methods were
// called — not what the user would end up with.
//
// What jsdom cannot do is lay anything out. Everything here is therefore
// geometry-free; how the picker actually looks and whether the confirm button
// is thumb-reachable is checked in a browser instead.

import { createMapPicker } from "./map-picker";
import type { LatLon } from "./types";
import type { PlaceMatch } from "./nominatim";

/** Central Stockholm — the phase-1 validation ground (docs/spec.md §10). */
const STOCKHOLM: LatLon = { lat: 59.3293, lon: 18.0686 };

/**
 * The map turns a tap into a coordinate through pixel arithmetic, and jsdom
 * gives every element zero size — so the map's centre sits at pixel (0, 0) and
 * an offset from there is measured in screen pixels: x grows east, y grows
 * south. Tapping with no offset therefore means "tap the middle of the map".
 */
function tapMap(container: HTMLElement, offset = { x: 0, y: 0 }): void {
  container.querySelector<HTMLElement>(".map-picker-map")!.dispatchEvent(
    new MouseEvent("click", {
      clientX: offset.x,
      clientY: offset.y,
      bubbles: true,
    }),
  );
}

/** Far enough from the middle to be unmistakably somewhere else. */
const SOUTH_EAST_OF_CENTRE = { x: 100, y: 100 };

function confirmButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(".map-picker-confirm")!;
}

function searchFor(container: HTMLElement, query: string): void {
  container.querySelector<HTMLInputElement>(".map-picker-search-input")!.value =
    query;
  container
    .querySelector<HTMLFormElement>(".map-picker-search-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

function tapFirstSearchResult(container: HTMLElement): void {
  container
    .querySelector<HTMLButtonElement>(".map-picker-search-result")!
    .click();
}

function pinCount(container: HTMLElement): number {
  return container.querySelectorAll(".leaflet-marker-icon").length;
}

/** Let a settled search promise's callbacks run before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A geocoder that never touches the network. */
function fakeSearch(...matches: PlaceMatch[]) {
  return vi.fn().mockResolvedValue(matches);
}

const findsNothing = () => Promise.resolve([]);

describe("createMapPicker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("credits OpenStreetMap on the map itself", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      search: findsNothing,
    });

    const attribution = container.querySelector(
      ".leaflet-control-attribution",
    )!;
    expect(attribution.textContent).toContain("OpenStreetMap");
    expect(
      attribution.querySelector('a[href*="openstreetmap.org/copyright"]'),
    ).not.toBeNull();

    picker.destroy();
  });

  it("starts with nothing chosen, and says what to do about it", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      search: findsNothing,
    });

    // No pin anywhere: the app is asking where the user is, not guessing.
    expect(pinCount(container)).toBe(0);
    expect(confirmButton(container).disabled).toBe(true);
    expect(confirmButton(container).textContent).toMatch(/tap the map/i);

    picker.destroy();
  });

  it("opens on the position the caller already has, when there is one", () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const picker = createMapPicker(container, {
      onPick,
      center: STOCKHOLM,
      search: findsNothing,
    });

    tapMap(container);
    confirmButton(container).click();

    // Tapping the middle of the map picks whatever it opened on. Whole-pixel
    // rounding at street zoom moves that by a few tens of metres.
    const [picked] = onPick.mock.calls[0];
    expect(picked.lat).toBeCloseTo(STOCKHOLM.lat, 3);
    expect(picked.lon).toBeCloseTo(STOCKHOLM.lon, 3);

    picker.destroy();
  });

  it("drops a pin where the user taps, and offers to use it", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      center: STOCKHOLM,
      search: findsNothing,
    });

    tapMap(container);

    expect(pinCount(container)).toBe(1);
    expect(confirmButton(container).disabled).toBe(false);
    expect(confirmButton(container).textContent).toMatch(/use this location/i);

    picker.destroy();
  });

  it("moves the one pin instead of littering the map when tapped again", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      center: STOCKHOLM,
      search: findsNothing,
    });

    tapMap(container);
    tapMap(container, SOUTH_EAST_OF_CENTRE);

    expect(pinCount(container)).toBe(1);

    picker.destroy();
  });

  it("waits for the user to confirm before reporting a position", () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const picker = createMapPicker(container, {
      onPick,
      center: STOCKHOLM,
      search: findsNothing,
    });

    tapMap(container);
    expect(onPick).not.toHaveBeenCalled();

    confirmButton(container).click();
    expect(onPick).toHaveBeenCalledTimes(1);

    picker.destroy();
  });

  it("reports the spot tapped last, not the one tapped first", () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const picker = createMapPicker(container, {
      onPick,
      center: STOCKHOLM,
      search: findsNothing,
    });

    tapMap(container);
    tapMap(container, SOUTH_EAST_OF_CENTRE);
    confirmButton(container).click();

    const [picked] = onPick.mock.calls[0];
    expect(picked.lat).toBeLessThan(STOCKHOLM.lat);
    expect(picked.lon).toBeGreaterThan(STOCKHOLM.lon);

    picker.destroy();
  });

  it("puts a place search above the map, for a user who would rather type", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      search: findsNothing,
    });

    const search = container.querySelector(".map-picker-search")!;
    const mapElement = container.querySelector(".map-picker-map")!;
    expect(
      search.compareDocumentPosition(mapElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    picker.destroy();
  });

  it("goes to a searched place and pins it, ready to confirm", async () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const sodermalm = { lat: 59.312, lon: 18.07 };
    const picker = createMapPicker(container, {
      onPick,
      search: fakeSearch({
        label: "Södermalm, Stockholm, Sverige",
        position: sodermalm,
      }),
    });

    searchFor(container, "Södermalm");
    await flush();
    tapFirstSearchResult(container);

    expect(pinCount(container)).toBe(1);
    confirmButton(container).click();
    expect(onPick).toHaveBeenCalledWith(sodermalm);

    picker.destroy();
  });

  it("lets a tap correct a searched place before it is confirmed", async () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const picker = createMapPicker(container, {
      onPick,
      search: fakeSearch({
        label: "Stockholm, Sverige",
        position: STOCKHOLM,
      }),
    });

    searchFor(container, "Stockholm");
    await flush();
    tapFirstSearchResult(container);
    tapMap(container, SOUTH_EAST_OF_CENTRE);
    confirmButton(container).click();

    expect(pinCount(container)).toBe(1);
    const [picked] = onPick.mock.calls[0];
    expect(picked.lat).toBeLessThan(STOCKHOLM.lat);
    expect(picked.lon).toBeGreaterThan(STOCKHOLM.lon);

    picker.destroy();
  });

  it("hands the container back the way it found it", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      center: STOCKHOLM,
      search: findsNothing,
    });
    tapMap(container);

    picker.destroy();

    expect(container.children).toHaveLength(0);
    expect(container.className).toBe("");
  });

  it("stops reporting picks once it has been destroyed", () => {
    const onPick = vi.fn<(position: LatLon) => void>();
    const picker = createMapPicker(container, {
      onPick,
      center: STOCKHOLM,
      search: findsNothing,
    });
    tapMap(container);
    const button = confirmButton(container);

    picker.destroy();
    button.click();

    expect(onPick).not.toHaveBeenCalled();
  });

  it("survives being destroyed twice", () => {
    const picker = createMapPicker(container, {
      onPick: vi.fn(),
      search: findsNothing,
    });

    picker.destroy();

    expect(() => picker.destroy()).not.toThrow();
  });
});
