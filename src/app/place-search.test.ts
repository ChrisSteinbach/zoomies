// @vitest-environment jsdom

import { createPlaceSearch } from "./place-search";
import type { PlaceMatch } from "./nominatim";

/** Let a settled search promise's callbacks run before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function typeAndSubmit(element: HTMLElement, query: string): void {
  const input = element.querySelector<HTMLInputElement>(
    ".map-picker-search-input",
  )!;
  input.value = query;
  element
    .querySelector<HTMLFormElement>(".map-picker-search-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

function resultLabels(element: HTMLElement): (string | null)[] {
  return [...element.querySelectorAll(".map-picker-search-result")].map(
    (button) => button.textContent,
  );
}

describe("createPlaceSearch", () => {
  it("lists the matching places once the user submits a query", async () => {
    const search = vi.fn().mockResolvedValue([
      { label: "Stockholm, Sverige", position: { lat: 59.33, lon: 18.07 } },
      {
        label: "Stockholm, Wisconsin, USA",
        position: { lat: 44.48, lon: -92.25 },
      },
    ] satisfies PlaceMatch[]);
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    typeAndSubmit(element, "Stockholm");
    await flush();

    expect(search).toHaveBeenCalledWith("Stockholm");
    expect(resultLabels(element)).toEqual([
      "Stockholm, Sverige",
      "Stockholm, Wisconsin, USA",
    ]);
  });

  it("reports the tapped place to the caller", async () => {
    const onSelect = vi.fn();
    const search = vi
      .fn()
      .mockResolvedValue([
        { label: "Södermalm, Stockholm", position: { lat: 59.31, lon: 18.07 } },
      ] satisfies PlaceMatch[]);
    const { element } = createPlaceSearch({ search, onSelect });

    typeAndSubmit(element, "Södermalm");
    await flush();
    element
      .querySelector<HTMLButtonElement>(".map-picker-search-result")!
      .click();

    expect(onSelect).toHaveBeenCalledWith({
      label: "Södermalm, Stockholm",
      position: { lat: 59.31, lon: 18.07 },
    });
  });

  it("clears the list once a place has been chosen, so it stops covering the map", async () => {
    const search = vi
      .fn()
      .mockResolvedValue([
        { label: "Södermalm, Stockholm", position: { lat: 59.31, lon: 18.07 } },
      ] satisfies PlaceMatch[]);
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    typeAndSubmit(element, "Södermalm");
    await flush();
    element
      .querySelector<HTMLButtonElement>(".map-picker-search-result")!
      .click();

    const list = element.querySelector<HTMLUListElement>(
      ".map-picker-search-results",
    )!;
    expect(list.hidden).toBe(true);
    expect(resultLabels(element)).toEqual([]);
  });

  it("says so when nothing matches, rather than leaving the user staring at an empty box", async () => {
    const search = vi.fn().mockResolvedValue([] satisfies PlaceMatch[]);
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    typeAndSubmit(element, "qwertyuiop");
    await flush();

    expect(
      element.querySelector(".map-picker-search-message")?.textContent,
    ).toBe("No places found");
  });

  it("admits it when the search itself fails, and invites another try", async () => {
    const search = vi.fn().mockRejectedValue(new Error("offline"));
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    typeAndSubmit(element, "Stockholm");
    await flush();

    expect(
      element.querySelector(".map-picker-search-message")?.textContent,
    ).toMatch(/failed.*try again/i);
  });

  it("refuses a second search while one is still in flight", async () => {
    let finishSearch: (matches: PlaceMatch[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<PlaceMatch[]>((resolve) => {
          finishSearch = resolve;
        }),
    );
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });
    const submit = element.querySelector<HTMLButtonElement>(
      ".map-picker-search-submit",
    )!;

    typeAndSubmit(element, "Stockholm");
    expect(submit.disabled).toBe(true);

    finishSearch([]);
    await flush();
    expect(submit.disabled).toBe(false);
  });

  it("ignores a submit with nothing but whitespace typed", () => {
    const search = vi.fn();
    const { element } = createPlaceSearch({ search, onSelect: vi.fn() });

    typeAndSubmit(element, "   ");

    expect(search).not.toHaveBeenCalled();
  });
});
