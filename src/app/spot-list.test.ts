// @vitest-environment jsdom

import {
  describeTags,
  renderSpotList,
  sortByDistanceFrom,
  spotLabel,
} from "./spot-list";
import type { SpotListCallbacks } from "./spot-list";
import type { DogSpot } from "./types";

// Real Stockholm parks, so the distances in these tests are distances that
// actually exist. Slussen and Vanadislunden are far enough apart (~3.3 km)
// that moving between them genuinely reshuffles the list.
const SLUSSEN = { lat: 59.3193, lon: 18.0715 };
const VANADISLUNDEN = { lat: 59.348179, lon: 18.0556013 };

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

const BJORNS = park({
  id: "way/58082448",
  name: "Björns Trädgårds hundrastgård",
  lat: 59.3156731,
  lon: 18.0736705,
  tags: { fenced: true, surface: "fine_gravel" },
});

const MONTELIUS = park({
  id: "node/13245355311",
  name: "Monteliusvägens hundrastgård",
  lat: 59.3207873,
  lon: 18.0596507,
  tags: { fenced: true },
});

const VANADIS = park({
  id: "way/703298765",
  name: "Category:Vanadislundens hundrastgård",
  lat: 59.348179,
  lon: 18.0556013,
  tags: { lit: true, surface: "grass" },
});

function noopCallbacks(): SpotListCallbacks {
  return { onSelect: vi.fn(), onDirections: vi.fn() };
}

/** A container attached to the document, so focus behaves as it would in a
 *  browser. */
function mount(): HTMLElement {
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

/** The rows, in the order they are rendered. Rows are `<li>` children of the
 *  list itself, which is what makes them addressable without class names. */
function rows(container: HTMLElement): HTMLLIElement[] {
  return [...container.querySelectorAll<HTMLLIElement>("ol > li")];
}

function rowTexts(container: HTMLElement): string[] {
  return rows(container).map((row) => row.textContent ?? "");
}

/** The button that selects a row: the first one, before "Open in maps". */
function selectButton(row: HTMLElement): HTMLButtonElement {
  return row.querySelectorAll("button")[0];
}

function directionsButton(row: HTMLElement): HTMLButtonElement {
  return row.querySelectorAll("button")[1];
}

describe("sortByDistanceFrom", () => {
  it("puts the nearest park first, whatever order it was given them in", () => {
    const ranked = sortByDistanceFrom(SLUSSEN, [VANADIS, BJORNS, MONTELIUS]);

    expect(ranked.map(({ spot }) => spot.id)).toEqual([
      BJORNS.id,
      MONTELIUS.id,
      VANADIS.id,
    ]);
  });

  it("re-sorts against a new position, because distance follows the user", () => {
    const spots = [BJORNS, MONTELIUS, VANADIS];

    const fromSlussen = sortByDistanceFrom(SLUSSEN, spots);
    const fromVanadislunden = sortByDistanceFrom(VANADISLUNDEN, spots);

    expect(fromSlussen.map(({ spot }) => spot.id)).toEqual([
      BJORNS.id,
      MONTELIUS.id,
      VANADIS.id,
    ]);
    expect(fromVanadislunden.map(({ spot }) => spot.id)).toEqual([
      VANADIS.id,
      MONTELIUS.id,
      BJORNS.id,
    ]);
  });

  it("carries each park's distance from the position it was ranked against", () => {
    const [nearest] = sortByDistanceFrom(SLUSSEN, [BJORNS]);

    expect(nearest.meters).toBeCloseTo(421.7, 0);
  });

  it("leaves the caller's array in the order they had it", () => {
    const spots = [VANADIS, BJORNS];

    sortByDistanceFrom(SLUSSEN, spots);

    expect(spots).toEqual([VANADIS, BJORNS]);
  });
});

describe("spotLabel", () => {
  it("uses the OSM name verbatim, oddities and all", () => {
    expect(spotLabel(VANADIS)).toBe("Category:Vanadislundens hundrastgård");
  });

  it("names an unnamed park rather than leaving it blank", () => {
    expect(spotLabel(park({ id: "relation/16078225" }))).toBe(
      "Unnamed dog park",
    );
  });
});

describe("describeTags", () => {
  it("says nothing at all about a tag OSM does not carry", () => {
    expect(describeTags({})).toEqual([]);
  });

  it("distinguishes a surveyed 'no' from OSM saying nothing", () => {
    expect(describeTags({ fenced: false })).toEqual(["Not fenced"]);
    expect(describeTags({})).toEqual([]);
  });

  it("mentions only the tags that are present", () => {
    expect(describeTags({ lit: true })).toEqual(["Lit"]);
  });

  it("lists fenced, lit and surface in that order", () => {
    expect(
      describeTags({ surface: "grass", lit: false, fenced: true }),
    ).toEqual(["Fenced", "Not lit", "Surface: grass"]);
  });

  it("passes a surface value through even when it is one we have never seen", () => {
    expect(describeTags({ surface: "woodchips" })).toEqual([
      "Surface: woodchips",
    ]);
  });

  it("spells OSM's underscores as spaces", () => {
    expect(describeTags({ surface: "fine_gravel" })).toEqual([
      "Surface: fine gravel",
    ]);
  });
});

describe("renderSpotList", () => {
  it("lists the parks nearest first, with each one's distance", () => {
    const container = mount();

    renderSpotList(
      container,
      [VANADIS, BJORNS, MONTELIUS],
      SLUSSEN,
      null,
      noopCallbacks(),
    );

    const texts = rowTexts(container);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("Björns Trädgårds hundrastgård");
    expect(texts[0]).toContain("422 m");
    expect(texts[1]).toContain("Monteliusvägens hundrastgård");
    expect(texts[1]).toContain("692 m");
    expect(texts[2]).toContain("Category:Vanadislundens hundrastgård");
    expect(texts[2]).toContain("3.3 km");
  });

  it("re-orders and re-measures when the user has moved", () => {
    const container = mount();
    const spots = [BJORNS, MONTELIUS, VANADIS];

    renderSpotList(container, spots, SLUSSEN, null, noopCallbacks());
    renderSpotList(container, spots, VANADISLUNDEN, null, noopCallbacks());

    const texts = rowTexts(container);
    expect(texts[0]).toContain("Category:Vanadislundens hundrastgård");
    expect(texts[0]).toContain("0 m");
    expect(texts[2]).toContain("Björns Trädgårds hundrastgård");
  });

  it("replaces the previous results instead of piling up new ones", () => {
    const container = mount();

    renderSpotList(
      container,
      [BJORNS, MONTELIUS],
      SLUSSEN,
      null,
      noopCallbacks(),
    );
    renderSpotList(container, [VANADIS], SLUSSEN, null, noopCallbacks());

    expect(rowTexts(container)).toHaveLength(1);
    expect(container.textContent).not.toContain("Björns");
  });

  it("calls an unnamed park an unnamed park", () => {
    const container = mount();

    renderSpotList(
      container,
      [park({ id: "relation/16078225" })],
      SLUSSEN,
      null,
      noopCallbacks(),
    );

    expect(rowTexts(container)[0]).toContain("Unnamed dog park");
  });

  it("shows the tags OSM does carry", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    const text = rowTexts(container)[0];
    expect(text).toContain("Fenced");
    expect(text).toContain("Surface: fine gravel");
  });

  it("reports a surveyed fenced=no as not fenced", () => {
    const container = mount();
    const ormholmen = park({
      id: "relation/3181480",
      name: "Ormholmen Hundön",
      tags: { fenced: false },
    });

    renderSpotList(container, [ormholmen], SLUSSEN, null, noopCallbacks());

    expect(rowTexts(container)[0]).toContain("Not fenced");
  });

  it("says nothing about fencing when OSM says nothing", () => {
    const container = mount();
    const untagged = park({ id: "way/485519155", name: "Hospitalparken" });

    renderSpotList(container, [untagged], SLUSSEN, null, noopCallbacks());

    expect(rowTexts(container)[0].toLowerCase()).not.toContain("fenced");
  });

  it("gives every row real buttons, so the list works from a keyboard", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    const [row] = rows(container);
    expect(selectButton(row)).toBeInstanceOf(HTMLButtonElement);
    expect(directionsButton(row)).toBeInstanceOf(HTMLButtonElement);
  });

  it("reports the park the user tapped", () => {
    const container = mount();
    const callbacks = noopCallbacks();

    renderSpotList(container, [BJORNS, VANADIS], SLUSSEN, null, callbacks);
    selectButton(rows(container)[1]).click();

    expect(callbacks.onSelect).toHaveBeenCalledWith(VANADIS.id);
  });

  it("clears the selection when the user taps the selected park again", () => {
    const container = mount();
    const callbacks = noopCallbacks();

    renderSpotList(container, [BJORNS], SLUSSEN, BJORNS.id, callbacks);
    selectButton(rows(container)[0]).click();

    expect(callbacks.onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the selected row and only that row", () => {
    const container = mount();

    renderSpotList(
      container,
      [BJORNS, MONTELIUS],
      SLUSSEN,
      MONTELIUS.id,
      noopCallbacks(),
    );

    const pressed = rows(container).map((row) =>
      selectButton(row).getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["false", "true"]);
  });

  it("takes a selection asserted from outside, so the map can drive it", () => {
    const container = mount();
    const spots = [BJORNS, MONTELIUS];

    renderSpotList(container, spots, SLUSSEN, BJORNS.id, noopCallbacks());
    renderSpotList(container, spots, SLUSSEN, MONTELIUS.id, noopCallbacks());

    const pressed = rows(container).map((row) =>
      selectButton(row).getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["false", "true"]);
  });

  it("asks for directions to the park whose button was tapped, and nothing else", () => {
    const container = mount();
    const callbacks = noopCallbacks();

    renderSpotList(container, [BJORNS, VANADIS], SLUSSEN, null, callbacks);
    directionsButton(rows(container)[0]).click();

    expect(callbacks.onDirections).toHaveBeenCalledWith(BJORNS.id);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("tells a screen reader which park each 'Open in maps' button belongs to", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    expect(
      directionsButton(rows(container)[0]).getAttribute("aria-label"),
    ).toBe("Open in maps: Björns Trädgårds hundrastgård");
  });

  it("keeps keyboard focus on the row the user is on when a GPS tick re-renders", () => {
    const container = mount();
    const spots = [BJORNS, MONTELIUS, VANADIS];

    renderSpotList(container, spots, SLUSSEN, null, noopCallbacks());
    selectButton(rows(container)[2]).focus();
    // The user walks north; Vanadislunden is now the nearest and the list
    // reorders under their thumb.
    renderSpotList(container, spots, VANADISLUNDEN, null, noopCallbacks());

    expect(document.activeElement).toBe(selectButton(rows(container)[0]));
    expect(document.activeElement?.textContent).toContain("Vanadislundens");
  });
});

describe("the directions button on a narrow screen", () => {
  // The media query itself is not reachable under jsdom, which has no layout.
  // What is worth pinning here is that dropping the words costs nothing: the
  // accessible name lives on the button, not in the text a phone hides.
  it("keeps the words and the arrow as separate elements", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    const button = directionsButton(rows(container)[0]);
    expect(
      button.querySelector(".spot-list-directions-label")?.textContent,
    ).toBe("Open in maps");
    expect(button.querySelector(".spot-list-directions-icon")).not.toBeNull();
  });

  it("names the park on the button itself, so hiding the words loses nothing", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    const button = directionsButton(rows(container)[0]);
    button.querySelector(".spot-list-directions-label")!.remove();

    expect(button.getAttribute("aria-label")).toBe(
      "Open in maps: Björns Trädgårds hundrastgård",
    );
  });

  it("hides the arrow from a screen reader, which already has the label", () => {
    const container = mount();

    renderSpotList(container, [BJORNS], SLUSSEN, null, noopCallbacks());

    expect(
      directionsButton(rows(container)[0])
        .querySelector(".spot-list-directions-icon")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
