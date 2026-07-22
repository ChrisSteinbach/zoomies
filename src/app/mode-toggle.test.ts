// @vitest-environment jsdom

import { renderModeToggle } from "./mode-toggle";
import type { ModeToggleCallbacks } from "./mode-toggle";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  return container;
}

function callbacks(
  overrides: Partial<ModeToggleCallbacks> = {},
): ModeToggleCallbacks {
  return {
    onFollow: () => {},
    onPick: () => {},
    ...overrides,
  };
}

function gpsButtonIn(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".mode-toggle-gps");
  if (!button) throw new Error("the GPS button should always be rendered");
  return button;
}

function pickButtonIn(container: HTMLElement): HTMLButtonElement {
  const button =
    container.querySelector<HTMLButtonElement>(".mode-toggle-pick");
  if (!button) throw new Error("the pick button should always be rendered");
  return button;
}

describe("the position-source group", () => {
  it("renders both buttons, GPS pressed and pick un-pressed, when following the GPS", () => {
    const container = mount();

    renderModeToggle(container, "gps", callbacks());

    const group = container.querySelector(".mode-toggle");
    if (!group) throw new Error("the group wrapper should always be rendered");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Position source");
    expect(gpsButtonIn(container).getAttribute("aria-pressed")).toBe("true");
    expect(pickButtonIn(container).getAttribute("aria-pressed")).toBe("false");
  });

  it('marks the pick side pressed and offers "Follow my location" when the position was picked', () => {
    const container = mount();

    renderModeToggle(container, "picked", callbacks());

    expect(pickButtonIn(container).getAttribute("aria-pressed")).toBe("true");
    const gps = gpsButtonIn(container);
    expect(gps.getAttribute("aria-pressed")).toBe("false");
    expect(gps.getAttribute("aria-label")).toBe("Follow my location");
    expect(gps.title).toBe("Follow my location");
  });

  it("shows the GPS side busy while a resume is waiting for its fix", () => {
    const container = mount();

    renderModeToggle(container, null, callbacks());

    const gps = gpsButtonIn(container);
    expect(gps.getAttribute("aria-pressed")).toBe("true");
    expect(gps.getAttribute("aria-busy")).toBe("true");
    expect(gps.getAttribute("aria-label")).toBe("Finding you…");
  });

  it("fires onFollow when the GPS side is tapped from a picked position", () => {
    const container = mount();
    const follows: number[] = [];

    renderModeToggle(
      container,
      "picked",
      callbacks({ onFollow: () => follows.push(1) }),
    );
    gpsButtonIn(container).click();

    expect(follows).toHaveLength(1);
  });

  it("ignores a tap on the GPS side while it is already following", () => {
    const container = mount();
    const follows: number[] = [];

    renderModeToggle(
      container,
      "gps",
      callbacks({ onFollow: () => follows.push(1) }),
    );
    gpsButtonIn(container).click();

    expect(follows).toHaveLength(0);
  });

  it("ignores a tap on the GPS side while a resume is already in flight", () => {
    const container = mount();
    const follows: number[] = [];

    renderModeToggle(
      container,
      null,
      callbacks({ onFollow: () => follows.push(1) }),
    );
    gpsButtonIn(container).click();

    expect(follows).toHaveLength(0);
  });

  it("fires onPick from either mode", () => {
    const container = mount();
    const picks: number[] = [];

    renderModeToggle(
      container,
      "gps",
      callbacks({ onPick: () => picks.push(1) }),
    );
    pickButtonIn(container).click();

    renderModeToggle(
      container,
      "picked",
      callbacks({ onPick: () => picks.push(1) }),
    );
    pickButtonIn(container).click();

    expect(picks).toHaveLength(2);
  });

  it("re-renders mutate the existing buttons rather than replacing them", () => {
    const container = mount();

    renderModeToggle(container, "gps", callbacks());
    const gpsBefore = gpsButtonIn(container);
    const pickBefore = pickButtonIn(container);

    renderModeToggle(container, "picked", callbacks());

    expect(gpsButtonIn(container)).toBe(gpsBefore);
    expect(pickButtonIn(container)).toBe(pickBefore);
  });
});
