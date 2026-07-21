// @vitest-environment jsdom

import { renderStatus } from "./status-view";
import type { StatusCallbacks } from "./status-view";
import { PlaceProviderError } from "./place-provider";
import type { PlaceProviderErrorKind } from "./place-provider";
import type { Phase } from "./state-machine";
import type { DogSpot } from "./types";

const SLUSSEN = { lat: 59.3193, lon: 18.0715 };

const BJORNS: DogSpot = {
  id: "way/58082448",
  kind: "dog_park",
  name: "Björns Trädgårds hundrastgård",
  lat: 59.3156731,
  lon: 18.0736705,
  tags: { fenced: true },
  provenance: "designated",
};

function callbacks(): StatusCallbacks {
  return {
    onRetry: vi.fn(),
    onPickPosition: vi.fn(),
    onRetryLocation: vi.fn(),
  };
}

function mount(): HTMLElement {
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

function failure(
  kind: PlaceProviderErrorKind,
  status?: number,
): PlaceProviderError {
  return new PlaceProviderError(kind, `${kind} from the fake provider`, {
    status,
  });
}

/** Everything the user can read, as one string. */
function words(container: HTMLElement): string {
  return container.textContent ?? "";
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function buttonLabels(container: HTMLElement): string[] {
  return buttons(container).map((button) => button.textContent ?? "");
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(container).find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) {
    throw new Error(
      `No button labelled "${label}" — found: ${buttonLabels(container).join(", ") || "none"}`,
    );
  }
  return found;
}

describe("renderStatus, while locating", () => {
  const LOCATING: Phase = { kind: "locating" };

  it("says what it is waiting for rather than spinning silently", () => {
    const container = mount();

    renderStatus(container, LOCATING, callbacks());

    expect(words(container)).toContain("Finding you");
    expect(words(container)).toContain("permission");
  });

  it("offers a way out, because a fix may never arrive", () => {
    const container = mount();
    const handlers = callbacks();

    renderStatus(container, LOCATING, handlers);
    button(container, "Set my position on the map").click();

    expect(handlers.onPickPosition).toHaveBeenCalled();
  });

  it("is the whole screen, since there is nothing behind it", () => {
    const container = mount();

    expect(renderStatus(container, LOCATING, callbacks())).toBe("takeover");
  });
});

describe("renderStatus, while searching", () => {
  it("says a search is running when there is nothing on screen yet", () => {
    const container = mount();
    const phase: Phase = {
      kind: "searching",
      position: SLUSSEN,
      staleSpots: [],
    };

    const presence = renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("Looking for dog parks");
    expect(presence).toBe("takeover");
  });

  it("stands aside as a note when results are still on screen", () => {
    const container = mount();
    const phase: Phase = {
      kind: "searching",
      position: SLUSSEN,
      staleSpots: [BJORNS],
    };

    const presence = renderStatus(container, phase, callbacks());

    expect(presence).toBe("notice");
    expect(words(container)).toContain("Updating results");
  });
});

describe("renderStatus, with no position", () => {
  it("tells someone who refused permission how to change their mind", () => {
    const container = mount();
    const phase: Phase = {
      kind: "needs-position",
      reason: "PERMISSION_DENIED",
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("permission");
    expect(words(container)).toContain("browser settings");
  });

  it("does not tell someone who refused permission that their device is broken", () => {
    const container = mount();
    const phase: Phase = {
      kind: "needs-position",
      reason: "PERMISSION_DENIED",
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).not.toContain("could not find you");
    expect(words(container)).not.toContain("too long");
  });

  it("offers a refused user no retry, because the browser will not ask twice", () => {
    const container = mount();
    const phase: Phase = {
      kind: "needs-position",
      reason: "PERMISSION_DENIED",
    };

    renderStatus(container, phase, callbacks());

    expect(buttonLabels(container)).toEqual(["Set my position on the map"]);
  });

  it("blames the device, not the user, when the position is unavailable", () => {
    const container = mount();
    const phase: Phase = {
      kind: "needs-position",
      reason: "POSITION_UNAVAILABLE",
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("Your device could not find you");
    expect(words(container)).toContain("indoors");
  });

  it("treats a timeout as something worth simply trying again", () => {
    const container = mount();
    const phase: Phase = { kind: "needs-position", reason: "TIMEOUT" };
    const handlers = callbacks();

    renderStatus(container, phase, handlers);
    button(container, "Try again").click();

    expect(words(container)).toContain("took too long");
    expect(handlers.onRetryLocation).toHaveBeenCalled();
    // Retrying the *search* is meaningless here: there is no position to
    // search from, and the state machine would drop the event.
    expect(handlers.onRetry).not.toHaveBeenCalled();
  });

  it("leads with the manual picker, which is the actual way out", () => {
    const container = mount();
    const phase: Phase = { kind: "needs-position", reason: "TIMEOUT" };
    const handlers = callbacks();

    renderStatus(container, phase, handlers);

    expect(buttonLabels(container)[0]).toBe("Set my position on the map");
    buttons(container)[0].click();
    expect(handlers.onPickPosition).toHaveBeenCalled();
  });
});

describe("renderStatus, having found nothing", () => {
  it("says how far it looked, using the radius it actually searched", () => {
    const container = mount();
    const phase: Phase = {
      kind: "empty",
      position: SLUSSEN,
      searchedRadiusM: 25_000,
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("No dog parks within 25 km");
  });

  it("reports a narrower search honestly rather than claiming 25 km", () => {
    const container = mount();
    const phase: Phase = {
      kind: "empty",
      position: SLUSSEN,
      searchedRadiusM: 3_000,
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("No dog parks within 3.0 km");
  });

  it("does not present a legitimate empty answer as a failure", () => {
    const container = mount();
    const phase: Phase = {
      kind: "empty",
      position: SLUSSEN,
      searchedRadiusM: 25_000,
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).not.toMatch(/error|failed|wrong|sorry|problem/i);
  });

  it("explains that OSM coverage is uneven rather than asserting there are none", () => {
    const container = mount();
    const phase: Phase = {
      kind: "empty",
      position: SLUSSEN,
      searchedRadiusM: 25_000,
    };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("coverage is uneven");
  });

  it("offers to look elsewhere, and nothing that would repeat the same search", () => {
    const container = mount();
    const phase: Phase = {
      kind: "empty",
      position: SLUSSEN,
      searchedRadiusM: 25_000,
    };
    const handlers = callbacks();

    renderStatus(container, phase, handlers);
    button(container, "Search somewhere else").click();

    expect(buttonLabels(container)).toEqual(["Search somewhere else"]);
    expect(handlers.onPickPosition).toHaveBeenCalled();
  });
});

describe("renderStatus, after a failed lookup", () => {
  function failedPhase(
    error: PlaceProviderError,
    staleSpots: DogSpot[] = [],
  ): Phase {
    return { kind: "failed", position: SLUSSEN, error, staleSpots };
  }

  it("says the search ran out of time when it timed out", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("timeout")), callbacks());

    expect(words(container)).toContain("took too long");
  });

  it("does not blame a timeout on the phone's connection", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("timeout")), callbacks());

    expect(words(container)).not.toContain("No connection");
  });

  it("says we are asking too often when rate-limited", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("rate-limited")), callbacks());

    expect(words(container)).toContain("Too many requests");
    expect(words(container)).toContain("slow down");
  });

  it("does not tell a rate-limited user they are offline", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("rate-limited")), callbacks());

    expect(words(container)).not.toMatch(/signal|Wi-Fi|No connection/);
  });

  it("says the connection failed when nothing reached the service", () => {
    const container = mount();

    renderStatus(
      container,
      failedPhase(failure("network-unavailable")),
      callbacks(),
    );

    expect(words(container)).toContain("No connection");
    expect(words(container)).toContain("signal");
  });

  it("treats a server fault as temporary and worth retrying", () => {
    const container = mount();
    const handlers = callbacks();

    renderStatus(container, failedPhase(failure("http-error", 503)), handlers);
    button(container, "Try again").click();

    expect(words(container)).toContain("struggling");
    expect(handlers.onRetry).toHaveBeenCalled();
  });

  it("offers no retry for a request the service will refuse every time", () => {
    const container = mount();

    renderStatus(
      container,
      failedPhase(failure("http-error", 400)),
      callbacks(),
    );

    expect(words(container)).toContain("refused");
    expect(buttonLabels(container)).toEqual(["Set my position on the map"]);
  });

  it("offers no retry for an answer that will not reparse", () => {
    const container = mount();

    renderStatus(
      container,
      failedPhase(failure("malformed-response")),
      callbacks(),
    );

    expect(words(container)).toContain("could not read");
    expect(buttonLabels(container)).toEqual(["Set my position on the map"]);
  });

  it("never shows a status code to the user", () => {
    const container = mount();

    renderStatus(
      container,
      failedPhase(failure("http-error", 503)),
      callbacks(),
    );

    expect(words(container)).not.toContain("503");
  });

  it("offers no retry when there is no position to search from", () => {
    const container = mount();
    const phase: Phase = {
      kind: "failed",
      position: null,
      error: failure("timeout"),
      staleSpots: [],
    };

    renderStatus(container, phase, callbacks());

    expect(buttonLabels(container)).toEqual(["Set my position on the map"]);
  });

  it("takes the screen over only when there is nothing behind it", () => {
    const container = mount();

    const presence = renderStatus(
      container,
      failedPhase(failure("timeout")),
      callbacks(),
    );

    expect(presence).toBe("takeover");
  });

  it("becomes a staleness caveat when results are still on screen", () => {
    const container = mount();

    const presence = renderStatus(
      container,
      failedPhase(failure("timeout"), [BJORNS]),
      callbacks(),
    );

    expect(presence).toBe("notice");
    expect(words(container)).toContain("These results may be out of date");
  });

  it("still explains why, and still offers retry, over stale results", () => {
    const container = mount();
    const handlers = callbacks();

    renderStatus(
      container,
      failedPhase(failure("timeout"), [BJORNS]),
      handlers,
    );
    button(container, "Try again").click();

    expect(words(container)).toContain("did not answer in time");
    expect(handlers.onRetry).toHaveBeenCalled();
  });
});

describe("renderStatus, once there are results", () => {
  const READY: Phase = {
    kind: "ready",
    position: SLUSSEN,
    spots: [BJORNS],
    searchedRadiusM: 3_000,
  };

  it("shows nothing, because the list owns that screen", () => {
    const container = mount();

    const presence = renderStatus(container, READY, callbacks());

    expect(presence).toBe("none");
    expect(words(container)).toBe("");
  });

  it("clears a failure that is no longer true", () => {
    const container = mount();

    renderStatus(
      container,
      {
        kind: "failed",
        position: SLUSSEN,
        error: failure("timeout"),
        staleSpots: [],
      },
      callbacks(),
    );
    renderStatus(container, READY, callbacks());

    expect(words(container)).toBe("");
    expect(buttons(container)).toHaveLength(0);
  });
});

describe("renderStatus and assistive technology", () => {
  it("announces politely, from a region that is watched before it changes", () => {
    const container = mount();

    renderStatus(container, { kind: "locating" }, callbacks());

    const region = container.firstElementChild;
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toContain("Finding you");
  });

  it("keeps the same region across states, so later changes are heard", () => {
    const container = mount();

    renderStatus(container, { kind: "locating" }, callbacks());
    const region = container.firstElementChild;
    renderStatus(
      container,
      { kind: "needs-position", reason: "TIMEOUT" },
      callbacks(),
    );

    expect(container.firstElementChild).toBe(region);
    expect(words(container)).toContain("took too long");
  });

  it("does not repeat itself when a GPS tick re-renders the same state", () => {
    const container = mount();
    const phase: Phase = {
      kind: "searching",
      position: SLUSSEN,
      staleSpots: [],
    };

    renderStatus(container, phase, callbacks());
    const message = container.querySelector("p");
    // The user has drifted a few metres; the phase says the same thing.
    renderStatus(
      container,
      { ...phase, position: { lat: 59.3194, lon: 18.0716 } },
      callbacks(),
    );

    expect(container.querySelector("p")).toBe(message);
  });

  it("does re-announce when the message itself changes", () => {
    const container = mount();

    renderStatus(
      container,
      { kind: "empty", position: SLUSSEN, searchedRadiusM: 3_000 },
      callbacks(),
    );
    const message = container.querySelector("p");
    renderStatus(
      container,
      { kind: "empty", position: SLUSSEN, searchedRadiusM: 25_000 },
      callbacks(),
    );

    expect(container.querySelector("p")).not.toBe(message);
    expect(words(container)).toContain("25 km");
  });

  it("gives every action a real button, operable from a keyboard", () => {
    const container = mount();

    renderStatus(
      container,
      { kind: "needs-position", reason: "TIMEOUT" },
      callbacks(),
    );

    for (const action of buttons(container)) {
      expect(action).toBeInstanceOf(HTMLButtonElement);
      expect(action.type).toBe("button");
    }
    expect(buttons(container)).toHaveLength(2);
  });
});

describe("renderStatus, when the browser offers no Geolocation at all", () => {
  it("names the insecure connection rather than blaming the device", () => {
    const container = mount();
    const phase: Phase = { kind: "needs-position", reason: "UNSUPPORTED" };

    renderStatus(container, phase, callbacks());

    expect(words(container)).toContain("secure connection");
    expect(words(container)).not.toContain("could not find you");
    expect(words(container)).not.toContain("browser settings");
  });

  it("still offers a way forward", () => {
    const container = mount();
    const phase: Phase = { kind: "needs-position", reason: "UNSUPPORTED" };

    renderStatus(container, phase, callbacks());

    expect(buttonLabels(container)).toEqual(["Set my position on the map"]);
  });
});

describe("renderStatus, when the service is full rather than throttling us", () => {
  function failedPhase(error: PlaceProviderError): Phase {
    return { kind: "failed", position: SLUSSEN, error, staleSpots: [] };
  }

  it("says the service is busy", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("busy")), callbacks());

    expect(words(container)).toContain("busy");
    expect(words(container)).toContain("free for everyone");
  });

  it("does not accuse the user of asking too often", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("busy")), callbacks());

    // A 504 is the shared instance full of everybody's queries. Someone who
    // opened the app twice is not the reason, and should not be told they are.
    expect(words(container)).not.toContain("Too many requests");
    expect(words(container)).not.toContain("slow down");
  });

  it("still offers a retry, because waiting is what fixes it", () => {
    const container = mount();

    renderStatus(container, failedPhase(failure("busy")), callbacks());

    expect(buttonLabels(container)).toEqual(["Try again"]);
  });
});
