// @vitest-environment jsdom

import { renderLayerToggle } from "./layer-toggle";
import type { LayerToggleCallbacks } from "./layer-toggle";
import type { BathingLayer } from "./state-machine";
import type { DogSpot, LatLon } from "./types";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  return container;
}

function callbacks(
  overrides: Partial<LayerToggleCallbacks> = {},
): LayerToggleCallbacks {
  return {
    onToggle: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

function chipIn(container: HTMLElement): HTMLButtonElement {
  const chip = container.querySelector<HTMLButtonElement>(".layer-toggle-chip");
  if (!chip) throw new Error("the chip should always be rendered");
  return chip;
}

/** The note's own sentence, apart from any invitation appended after it. */
function noteTextIn(container: HTMLElement): string {
  const span = container.querySelector<HTMLElement>(".layer-toggle-note-text");
  if (!span) throw new Error("a rendered note should carry a text span");
  return span.textContent ?? "";
}

function invitationIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".contribute-invitation");
}

const OFF: BathingLayer = { kind: "off" };
const LOADING: BathingLayer = { kind: "loading", staleSpots: [] };

// One user position and a spread of bathing spots at increasing distance
// from it. Every distance in the comments below is a haversine actually run
// against src/app/geo.ts, not an eyeballed guess, so a note's exact wording
// can be pinned rather than pattern-matched.
const P: LatLon = { lat: 59.32, lon: 18.07 };
/** ~7.9 km further north than P — far enough that FAR (13 km from P) is only
 *  ~5.0 km from here, a GPS tick that should tick the note's text but not
 *  its identity. */
const MOVED: LatLon = { lat: 59.392, lon: 18.07 };

function bathingSpot(id: string, lat: number): DogSpot {
  return {
    id,
    kind: "bathing_spot",
    lat,
    lon: 18.07,
    tags: {},
    provenance: "permitted",
  };
}

const NEAR = bathingSpot("way/10", 59.323); // ~334 m from P
const NEARBY = bathingSpot("way/11", 59.321); // ~111 m from P
const WALKABLE = bathingSpot("way/12", 59.338); // ~2.0 km from P
const FAR = bathingSpot("way/13", 59.437); // ~13 km from P, ~5.0 km from MOVED
const FAR2 = bathingSpot("way/14", 59.464); // ~16 km from P
const FAR3 = bathingSpot("way/15", 59.482); // ~18 km from P

describe("the bathing-spots chip", () => {
  it("reads as unpressed while the layer is off", () => {
    const container = mount();

    renderLayerToggle(container, OFF, P, callbacks());

    const chip = chipIn(container);
    expect(chip.textContent).toBe("Bathing spots");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("reads as pressed and busy while the layer is looking", () => {
    const container = mount();

    renderLayerToggle(container, LOADING, P, callbacks());

    const chip = chipIn(container);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.getAttribute("aria-busy")).toBe("true");
  });

  it("reports a tap through the toggle callback", () => {
    const container = mount();
    const toggles: number[] = [];

    renderLayerToggle(
      container,
      OFF,
      P,
      callbacks({ onToggle: () => toggles.push(1) }),
    );
    chipIn(container).click();

    expect(toggles).toHaveLength(1);
  });

  it("is the same element across renders, so focus survives a GPS tick", () => {
    const container = mount();

    renderLayerToggle(container, OFF, P, callbacks());
    const before = chipIn(container);
    before.focus();
    renderLayerToggle(container, LOADING, P, callbacks());

    expect(chipIn(container)).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});

describe("the note beside the chip", () => {
  it("says it is looking while the search runs", () => {
    const container = mount();

    renderLayerToggle(container, LOADING, P, callbacks());

    expect(container.textContent).toContain("Looking for bathing spots…");
  });

  it("counts what it found when the nearest spot is close by", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [NEAR, NEARBY], searchedRadiusM: 10_000 },
      P,
      callbacks(),
    );

    // Both spots sit under a kilometre away (334 m and 111 m): the count is
    // the whole answer, and naming either distance would just narrate what
    // the list beside it already shows.
    expect(noteTextIn(container)).toBe("2 bathing spots.");
    expect(noteTextIn(container)).not.toContain("nearest");
    expect(invitationIn(container)).toBeNull();
  });

  it("names the reach when the nearest is beyond a kilometre", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [WALKABLE, FAR], searchedRadiusM: 10_000 },
      P,
      callbacks(),
    );

    // The nearer of the two, WALKABLE at 2.0 km, is what "nearest" reports —
    // FAR being in the same batch does not change how close the find is.
    expect(noteTextIn(container)).toBe("2 bathing spots, nearest 2.0 km.");
    // 2.0 km is inside the first search rung (3 km): a real nearby find, not
    // evidence the map is thin, so no invitation.
    expect(invitationIn(container)).toBeNull();
  });

  it("speaks in the singular for one spot", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [FAR], searchedRadiusM: 10_000 },
      P,
      callbacks(),
    );

    expect(noteTextIn(container)).toBe("1 bathing spot, nearest 13 km.");
  });

  it("recruits the fix when the nearest find is beyond the first search rung", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [FAR, FAR2, FAR3], searchedRadiusM: 25_000 },
      P,
      callbacks(),
    );

    // FAR is the nearest of the three, and it is already past the 3 km rung
    // the search would have stopped at: the narrowest query found nothing,
    // so the note recruits a mapper as well as reporting the count.
    expect(container.textContent).toContain("3 bathing spots, nearest 13 km.");
    const invitation = invitationIn(container);
    if (!invitation) {
      throw new Error("a find beyond the first rung should invite the fix");
    }
    expect(invitation.textContent).toContain(
      "Know a bathing spot that’s missing?",
    );
    const link = invitation.querySelector("a");
    if (!link) throw new Error("the invitation should link out to OSM");
    expect(link.getAttribute("href")).toBe(
      "https://www.openstreetmap.org/fixthemap",
    );
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.textContent).toBe("Add it to OpenStreetMap");
  });

  it("names how far it looked when it found nothing", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [], searchedRadiusM: 25_000 },
      P,
      callbacks(),
    );

    expect(container.textContent).toContain("No bathing spots within 25 km.");
  });

  it("invites the fix when it found nothing at all", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [], searchedRadiusM: 25_000 },
      P,
      callbacks(),
    );

    // An empty layer is the widest search coming back with nothing — the
    // same data-gap signal as a nearest find beyond the first rung.
    expect(invitationIn(container)).not.toBeNull();
  });

  it("offers a retry when the lookup failed, and reports the tap", () => {
    const container = mount();
    const retries: number[] = [];

    renderLayerToggle(
      container,
      { kind: "failed", staleSpots: [] },
      P,
      callbacks({ onRetry: () => retries.push(1) }),
    );

    expect(container.textContent).toContain("Couldn’t load bathing spots.");
    const retry = container.querySelector<HTMLButtonElement>(
      ".layer-toggle-retry",
    );
    if (!retry) throw new Error("a failed layer should offer a retry");
    retry.click();
    expect(retries).toHaveLength(1);
  });

  it("a failure never recruits mappers", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "failed", staleSpots: [] },
      P,
      callbacks(),
    );

    // Nothing is missing here — the service broke. Recruiting a mapper would
    // misdirect the blame, exactly as attribution.ts's rationale says.
    expect(invitationIn(container)).toBeNull();
  });

  it("reads as a caveat, not a failure, when stale spots are still showing", () => {
    const container = mount();

    renderLayerToggle(
      container,
      {
        kind: "failed",
        staleSpots: [bathingSpot("way/9", 59.32)],
      },
      P,
      callbacks(),
    );

    expect(container.textContent).toContain(
      "These bathing spots may be out of date.",
    );
    expect(container.textContent).not.toContain("Couldn’t load");
  });

  it("disappears when the layer is toggled off", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "failed", staleSpots: [] },
      P,
      callbacks(),
    );
    renderLayerToggle(container, OFF, P, callbacks());

    expect(container.querySelector(".layer-toggle-note")).toBeNull();
  });

  it("keeps the note element while the distance ticks down, so focus on its link survives a GPS tick", () => {
    const container = mount();
    const layer: BathingLayer = {
      kind: "ready",
      spots: [FAR],
      searchedRadiusM: 10_000,
    };

    renderLayerToggle(container, layer, P, callbacks());
    const note = container.querySelector(".layer-toggle-note");
    const link = container.querySelector("a");
    if (!note || !link) {
      throw new Error(
        "a far-away find should already carry a note and an invitation link",
      );
    }

    // Same layer, same shape of note (still no retry, still an invitation) —
    // only the walker's position, and so only the distance, has moved.
    renderLayerToggle(container, layer, MOVED, callbacks());

    expect(container.querySelector(".layer-toggle-note")).toBe(note);
    expect(container.querySelector("a")).toBe(link);
    expect(container.textContent).toContain("nearest 5.0 km");
  });
});
