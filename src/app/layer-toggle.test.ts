// @vitest-environment jsdom

import { renderLayerToggle } from "./layer-toggle";
import type { LayerToggleCallbacks } from "./layer-toggle";
import type { BathingLayer } from "./state-machine";

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

const OFF: BathingLayer = { kind: "off" };
const LOADING: BathingLayer = { kind: "loading", staleSpots: [] };

describe("the bathing-spots chip", () => {
  it("reads as unpressed while the layer is off", () => {
    const container = mount();

    renderLayerToggle(container, OFF, callbacks());

    const chip = chipIn(container);
    expect(chip.textContent).toBe("Bathing spots");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("reads as pressed and busy while the layer is looking", () => {
    const container = mount();

    renderLayerToggle(container, LOADING, callbacks());

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
      callbacks({ onToggle: () => toggles.push(1) }),
    );
    chipIn(container).click();

    expect(toggles).toHaveLength(1);
  });

  it("is the same element across renders, so focus survives a GPS tick", () => {
    const container = mount();

    renderLayerToggle(container, OFF, callbacks());
    const before = chipIn(container);
    before.focus();
    renderLayerToggle(container, LOADING, callbacks());

    expect(chipIn(container)).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});

describe("the note beside the chip", () => {
  it("says it is looking while the search runs", () => {
    const container = mount();

    renderLayerToggle(container, LOADING, callbacks());

    expect(container.textContent).toContain("Looking for bathing spots…");
  });

  it("says nothing when there are spots — the list is the answer", () => {
    const container = mount();

    renderLayerToggle(
      container,
      {
        kind: "ready",
        spots: [
          {
            id: "way/9",
            kind: "bathing_spot",
            lat: 59.32,
            lon: 18.03,
            tags: {},
            provenance: "permitted",
          },
        ],
        searchedRadiusM: 10_000,
      },
      callbacks(),
    );

    expect(container.querySelector(".layer-toggle-note")).toBeNull();
  });

  it("names how far it looked when it found nothing", () => {
    const container = mount();

    renderLayerToggle(
      container,
      { kind: "ready", spots: [], searchedRadiusM: 25_000 },
      callbacks(),
    );

    expect(container.textContent).toContain("No bathing spots within 25 km.");
  });

  it("offers a retry when the lookup failed, and reports the tap", () => {
    const container = mount();
    const retries: number[] = [];

    renderLayerToggle(
      container,
      { kind: "failed", staleSpots: [] },
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

  it("reads as a caveat, not a failure, when stale spots are still showing", () => {
    const container = mount();

    renderLayerToggle(
      container,
      {
        kind: "failed",
        staleSpots: [
          {
            id: "way/9",
            kind: "bathing_spot",
            lat: 59.32,
            lon: 18.03,
            tags: {},
            provenance: "permitted",
          },
        ],
      },
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
      callbacks(),
    );
    renderLayerToggle(container, OFF, callbacks());

    expect(container.querySelector(".layer-toggle-note")).toBeNull();
  });
});
