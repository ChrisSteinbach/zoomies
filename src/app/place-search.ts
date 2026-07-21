// The search box that sits above the map picker: type a place name, tap a
// match, and the map goes there.
//
// Deliberately free of Leaflet — it knows how to run a search and report the
// chosen match, nothing about maps — so the Leaflet glue in map-picker.ts stays
// thin and this widget is testable on its own.

import type { PlaceMatch } from "./nominatim";

export interface PlaceSearchDeps {
  /** Runs a geocoding query. Injected so tests stay offline. */
  search: (query: string) => Promise<PlaceMatch[]>;
  /** Called when the user taps a match. */
  onSelect: (match: PlaceMatch) => void;
}

export interface PlaceSearchHandle {
  /** Root element, to be mounted above the map. */
  element: HTMLElement;
}

export function createPlaceSearch({
  search,
  onSelect,
}: PlaceSearchDeps): PlaceSearchHandle {
  const wrapper = document.createElement("div");
  wrapper.className = "map-picker-search";

  const form = document.createElement("form");
  form.className = "map-picker-search-form";
  form.setAttribute("role", "search");

  const input = document.createElement("input");
  input.type = "search";
  input.className = "map-picker-search-input";
  input.placeholder = "Search for a place…";
  input.setAttribute("aria-label", "Search for a place");
  input.autocomplete = "off";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "map-picker-search-submit";
  submit.textContent = "Search";

  form.append(input, submit);

  const results = document.createElement("ul");
  results.className = "map-picker-search-results";
  results.hidden = true;

  wrapper.append(form, results);

  function hideResults(): void {
    results.textContent = "";
    results.hidden = true;
  }

  function showMessage(text: string): void {
    results.textContent = "";
    const item = document.createElement("li");
    item.className = "map-picker-search-message";
    item.textContent = text;
    results.appendChild(item);
    results.hidden = false;
  }

  function showMatches(matches: PlaceMatch[]): void {
    results.textContent = "";
    for (const match of matches) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-picker-search-result";
      button.textContent = match.label;
      button.addEventListener("click", () => {
        onSelect(match);
        hideResults();
      });
      item.appendChild(button);
      results.appendChild(item);
    }
    results.hidden = false;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query === "") return;

    // Submit only — never per keystroke. Nominatim's usage policy forbids
    // autocomplete-style querying, and disabling the button while a request is
    // in flight keeps an impatient user from queueing up a burst of them.
    submit.disabled = true;

    search(query)
      .then((matches) => {
        if (matches.length === 0) {
          showMessage("No places found");
        } else {
          showMatches(matches);
        }
      })
      .catch(() => {
        showMessage("Search failed. Please try again.");
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  return { element: wrapper };
}
