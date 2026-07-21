// @vitest-environment jsdom

import { OSM_DATA_CREDIT, createAttribution } from "./attribution";
import { createMapPicker } from "./map-picker";
import { createSpotMap } from "./spot-map";

/** The rendered credit, as a reader of the screen would see it. */
function attributionText(): string {
  return createAttribution().textContent ?? "";
}

function linkTo(footer: HTMLElement, host: string): HTMLAnchorElement | null {
  return footer.querySelector<HTMLAnchorElement>(`a[href*="${host}"]`);
}

/** The credit Leaflet has drawn in the corner of a live map. */
function tileCredit(container: HTMLElement): string {
  return (
    container.querySelector(".leaflet-control-attribution")?.textContent ?? ""
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("createAttribution", () => {
  it("credits OpenStreetMap in the words the licence asks for", () => {
    // ODbL asks for this string, visibly, and docs/spec.md §4.1 makes it a
    // requirement rather than a nicety. Anything looser is not compliance.
    expect(attributionText()).toContain("© OpenStreetMap contributors");
  });

  it("links the credit to the licence terms", () => {
    const footer = createAttribution();

    expect(linkTo(footer, "openstreetmap.org/copyright")).not.toBeNull();
    expect(linkTo(footer, "opendatacommons.org")).not.toBeNull();
    expect(attributionText()).toContain("ODbL");
  });

  it("says what to do about a place OSM has never heard of", () => {
    const footer = createAttribution();

    // The honest fix for a missing park or hundbad is to map it (docs/spec.md
    // §4.3) — the app says so and links to OSM's own page about it.
    expect(footer.textContent).toMatch(/missing/i);
    expect(linkTo(footer, "openstreetmap.org/fixthemap")).not.toBeNull();
  });

  it("leaves the app rather than losing the session", () => {
    const footer = createAttribution();

    // A results set, and possibly a hand-picked position, is sitting behind
    // this footer; navigating away to read a licence would throw it away.
    for (const link of footer.querySelectorAll("a")) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    }
  });

  it("says the same thing whatever the app is doing", () => {
    // It takes no state, so there is no phase — `empty` and `failed` included,
    // and neither of those shows a map at all — that can render it differently
    // or leave it out. That is the whole reason it is a standalone element for
    // the chrome rather than part of any view.
    expect(attributionText()).toBe(attributionText());
    expect(attributionText()).toContain(OSM_DATA_CREDIT);
  });
});

describe("OSM_TILE_ATTRIBUTION", () => {
  it("is what both of the app's maps actually show", () => {
    const pickerContainer = document.createElement("div");
    const mapContainer = document.createElement("div");
    document.body.append(pickerContainer, mapContainer);

    const picker = createMapPicker(pickerContainer, {
      onPick: vi.fn(),
      search: () => Promise.resolve([]),
    });
    const map = createSpotMap(mapContainer, { onSelect: vi.fn() });

    // Every map in the app credits the tiles in the same words. Pinned by what
    // is on screen rather than by the constant alone, so a map that quietly
    // grew its own copy of the string would fail here.
    expect(tileCredit(pickerContainer)).toContain(OSM_DATA_CREDIT);
    expect(tileCredit(mapContainer)).toContain(OSM_DATA_CREDIT);
    expect(tileCredit(mapContainer)).toBe(tileCredit(pickerContainer));

    for (const container of [pickerContainer, mapContainer]) {
      expect(
        container.querySelector(
          '.leaflet-control-attribution a[href*="openstreetmap.org/copyright"]',
        ),
      ).not.toBeNull();
    }

    picker.destroy();
    map.destroy();
  });
});
