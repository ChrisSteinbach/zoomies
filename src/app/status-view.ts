// Everything the app shows when it is not showing a list of results
// (docs/spec.md §7.6, and three of the phase-1 exit criteria in §10).
//
// A view and nothing else, exactly like the result list beside it: it is
// handed a phase and some callbacks and it renders them. It owns no state,
// runs no transitions and fetches nothing, so what "Try again" actually *does*
// stays the composition root's business.
//
// These are the states easiest to ship as a spinner that never resolves, so
// each one gets words of its own — and, separately, an honest answer to "is
// there anything here the user can usefully press?". A button that cannot help
// is worse than no button, which is why a failure the data layer calls
// unretryable never grows a "Try again", and why the two retries below are
// distinct: retrying a search and starting the hunt for a position again are
// different acts with different odds.

import type { Phase } from "./state-machine";
import type { LocationErrorCode } from "./location";
import type { PlaceProviderError } from "./place-provider";
import type { LatLon } from "./types";
import { createContributionInvitation } from "./attribution";
import { formatDistance } from "./format";
import { mappingDensityAt } from "./mapping-density";

export interface StatusCallbacks {
  /** Run the failed lookup again, from the position we already have. */
  onRetry: () => void;
  /** Open the manual position picker (docs/spec.md §7.1). */
  onPickPosition: () => void;
  /**
   * Start looking for the device's position again.
   *
   * Not the same button as {@link onRetry}: from `needs-position` there is no
   * position to search from, so a search retry is a no-op and the only useful
   * act is asking the device again.
   */
  onRetryLocation: () => void;
  /**
   * Reach for the device's position for the first time — the welcome screen's
   * primary choice, and where the app finally asks for permission.
   *
   * Distinct from {@link onRetryLocation}, which is the same act after a
   * failure: here nothing has been tried yet, so there is no "again".
   */
  onRequestLocation: () => void;
}

/**
 * What the status region ended up showing, so the caller knows what to do with
 * the results underneath it.
 */
export type StatusPresence =
  /** Nothing to say. The list owns the screen. */
  | "none"
  /** The status *is* the screen: there is nothing behind it to preserve. */
  | "takeover"
  /**
   * A note above results that are still on screen and still worth reading.
   * A refresh that fails must not blank what the user already has
   * (docs/spec.md §7.6), so this form announces itself as "possibly stale"
   * rather than taking the screen over.
   */
  | "notice";

/** The welcome screen's primary call: hand the app the device's location. */
const USE_MY_LOCATION = "Use my location";

/**
 * The picker as offered on the welcome screen — a first-class way in, not a
 * rescue, so it invites ("Choose…") rather than instructs ("Set…").
 */
const CHOOSE_ON_MAP = "Choose a spot on the map";

/** The button label for the manual picker, in the states where it is a rescue. */
const PICK_POSITION = "Set my position on the map";

/**
 * The same picker, in `empty` — where nothing is broken and the user is simply
 * somewhere with no dog parks. The button says what they get, not what it fixes.
 */
const SEARCH_ELSEWHERE = "Search somewhere else";

const TRY_AGAIN = "Try again";

/** The signature stored for a phase with nothing to show; see {@link renderStatus}. */
const NOTHING_TO_SAY = "none";

const REGION_CLASS = "status-view";

/**
 * Render the status for `phase` into `container`, replacing whatever it said
 * before, and report what it now shows.
 *
 * Takes the whole {@link Phase} union, `ready` included, rather than a type
 * that refuses `ready`. Two reasons: which phases have a status is precisely
 * the knowledge this module exists to own, and `ready` is not "nothing to do"
 * — it is "clear the failure that was here a moment ago".
 *
 * Idempotent, and deliberately lazy: re-rendering a phase that reads the same
 * leaves the DOM untouched. That is what keeps the live region from shouting
 * the same sentence at a screen-reader user on every GPS tick, and it means
 * the callbacks bound to the buttons must not close over per-render data —
 * they will outlive the render that created them.
 */
export function renderStatus(
  container: HTMLElement,
  phase: Phase,
  callbacks: StatusCallbacks,
): StatusPresence {
  const region = ensureRegion(container);
  const content = describeStatus(phase);
  const signature = content ? content.signature : NOTHING_TO_SAY;

  if (region.dataset.statusSignature !== signature) {
    region.dataset.statusSignature = signature;
    region.replaceChildren(...(content ? [buildCard(content, callbacks)] : []));
  }

  return content ? content.presence : "none";
}

/**
 * The live region, created once and then kept.
 *
 * It has to already be in the document when its text changes, or assistive
 * technology has nothing to watch and the change goes unannounced — so it
 * stays put through `ready` (empty, and hidden by the stylesheet) rather than
 * being torn down and rebuilt for the next message.
 */
function ensureRegion(container: HTMLElement): HTMLElement {
  const existing = container.firstElementChild;
  if (existing instanceof HTMLElement && existing.className === REGION_CLASS) {
    return existing;
  }

  const region = document.createElement("div");
  region.className = REGION_CLASS;
  // role="status" carries aria-live="polite" and aria-atomic="true" with it:
  // announced at the next pause rather than interrupting, and read as a whole
  // so the headline and the explanation arrive together.
  region.setAttribute("role", "status");
  container.replaceChildren(region);
  return region;
}

type ActionTone = "primary" | "secondary";

interface StatusAction {
  label: string;
  tone: ActionTone;
  run: (callbacks: StatusCallbacks) => void;
}

interface StatusContent {
  presence: Exclude<StatusPresence, "none">;
  /**
   * Everything about the phase that reaches the user's eyes, and nothing else.
   * Two renders with the same signature say the same words, so the second one
   * can be skipped — the position in `searching` is absent on purpose.
   */
  signature: string;
  /** The phase's own name, as a styling hook. */
  status: Phase["kind"];
  title: string;
  detail?: string;
  /**
   * Append the add-it-to-OSM invitation (attribution.ts) after the detail.
   * Set exactly where the state is a data gap the reader might personally
   * fill — the empty answers — and never on failures, where nothing is
   * missing and the invitation would misdirect the blame.
   */
  invite?: boolean;
  actions: StatusAction[];
}

function describeStatus(phase: Phase): StatusContent | null {
  switch (phase.kind) {
    case "ready":
      // The list owns this one.
      return null;

    case "welcome":
      return welcome();

    case "locating":
      return {
        presence: "takeover",
        signature: "locating",
        status: "locating",
        title: "Finding you…",
        detail:
          "Waiting for your device's location. Your browser may ask for permission first.",
        // A fix can take half a minute outdoors and may never arrive at all.
        // Offering the way out here is the difference between waiting and
        // being stuck.
        actions: [pick(PICK_POSITION, "secondary")],
      };

    case "searching":
      return phase.staleSpots.length > 0
        ? {
            presence: "notice",
            signature: "searching:stale",
            status: "searching",
            title: "Updating results…",
            actions: [],
          }
        : {
            presence: "takeover",
            signature: "searching",
            status: "searching",
            title: "Looking for dog parks…",
            detail: "Searching the area around you.",
            actions: [],
          };

    case "needs-position":
      return needsPosition(phase.reason);

    case "empty":
      return empty(phase.searchedRadiusM, phase.position);

    case "failed":
      return failed(
        phase.error,
        phase.position !== null,
        phase.staleSpots.length > 0,
      );
  }
}

/**
 * The front door, shown before the app reaches for a position (docs/spec.md
 * §7.1).
 *
 * A takeover like the others, but an invitation rather than a status: it names
 * the app, says in one line what it is for, and offers the two ways in. The
 * location request then rides a real tap — the primary button — instead of
 * firing on load, which is the whole point of the pause. The map picker is the
 * equal alternative for anyone who would rather not share their location at
 * all, wired to the same `onPickPosition` the rescue states use.
 */
function welcome(): StatusContent {
  return {
    presence: "takeover",
    signature: "welcome",
    status: "welcome",
    title: "Zoomies",
    detail:
      "Find somewhere for your dog to run — the nearest dog parks, wherever you are.",
    actions: [requestLocation(), pick(CHOOSE_ON_MAP, "secondary")],
  };
}

/**
 * No position, and the manual picker is the way out (docs/spec.md §7.1) — so
 * it leads in all three cases.
 *
 * The three codes are three different situations and get three different
 * explanations. Telling someone who tapped "Block" that their GPS is broken
 * sends them to fix the wrong thing; so does telling someone standing in a
 * basement that they refused permission.
 */
function needsPosition(reason: LocationErrorCode): StatusContent {
  const base = {
    presence: "takeover",
    signature: `needs-position:${reason}`,
    status: "needs-position",
  } as const;

  switch (reason) {
    case "PERMISSION_DENIED":
      return {
        ...base,
        title: "Location sharing is off",
        detail:
          "This site does not have permission to see where you are. You can turn that back on in your browser settings and reload, or set your position by hand.",
        // No "Try again": once permission is refused the browser will not ask
        // a second time, so the request would fail instantly and identically.
        actions: [pick(PICK_POSITION)],
      };

    case "POSITION_UNAVAILABLE":
      return {
        ...base,
        title: "Your device could not find you",
        detail:
          "The location service is not giving out a position. That happens indoors, and when location is switched off on the device itself.",
        actions: [pick(PICK_POSITION), retryLocation()],
      };

    case "TIMEOUT":
      return {
        ...base,
        title: "Finding you took too long",
        detail:
          "No position arrived in time. Somewhere with a clearer view of the sky usually helps.",
        actions: [pick(PICK_POSITION), retryLocation()],
      };

    case "UNSUPPORTED":
      return {
        ...base,
        title: "This browser will not share your location",
        // Names the usual cause, because "not supported" on its own sends
        // people to their device settings, where there is nothing to fix. No
        // "Try again": asking a browser that has no Geolocation API a second
        // time fails identically.
        detail:
          "Location needs a secure connection, so it is unavailable on pages served over plain http. Opening this app over https should bring the permission prompt back.",
        actions: [pick(PICK_POSITION)],
      };
  }
}

/**
 * Searched as far as we go and found nothing.
 *
 * A legitimate answer in a sparsely mapped region, not a failure (docs/spec.md
 * §3) — so it apologises for nothing, blames nothing, and says plainly how far
 * it looked. The radius comes from the phase because "nothing within 3 km" and
 * "nothing within 25 km" are different statements.
 *
 * How much the answer *means* depends on where it was asked (docs/spec.md
 * §4.5.1, encoded in mapping-density.ts). Where OSM's dog-park layer is dense,
 * an empty answer is fair evidence of absence, and the mild hedge stands.
 * Everywhere else the honest reading is that the *map* is probably what's
 * empty — so the title gains the word "mapped", carrying the claim the app
 * can actually stand behind, and the detail says which of the two silences
 * this one likely is. Same two variants of one card, not a warning banner:
 * nothing is broken, and dressing honesty up as an error would teach users
 * to dismiss it.
 *
 * Both variants end on "nobody has added it yet", and both carry the
 * invitation that is the actionable half of that sentence (docs/spec.md
 * §4.3): the reader standing in front of an unmapped dog park is the one
 * person who can make this answer better.
 */
function empty(searchedRadiusM: number, position: LatLon): StatusContent {
  const density = mappingDensityAt(position);
  const base = {
    presence: "takeover" as const,
    signature: `empty:${density}:${searchedRadiusM}`,
    status: "empty" as const,
    invite: true,
    // No retry: the same search would return the same nothing. Looking from
    // somewhere else is the only move that changes the answer.
    actions: [pick(SEARCH_ELSEWHERE)],
  };

  if (density === "sparse") {
    return {
      ...base,
      title: `No dog parks mapped within ${formatDistance(searchedRadiusM)}`,
      detail:
        "Few dog parks are mapped in this part of the world. There may well be one nearby that nobody has added to OpenStreetMap yet.",
    };
  }

  return {
    ...base,
    title: `No dog parks within ${formatDistance(searchedRadiusM)}`,
    detail:
      "OpenStreetMap has none mapped around here. Its coverage is uneven, so there may be a park that nobody has added yet.",
  };
}

/** The failure kinds, split where the same kind reads differently to a user. */
type FailureKey =
  | "timeout"
  | "rate-limited"
  | "busy"
  | "network-unavailable"
  | "malformed-response"
  /** 5xx: the far end fell over, and that is usually temporary. */
  | "server-error"
  /** 4xx: our request was wrong, and repeating it verbatim stays wrong. */
  | "request-error";

interface FailureMessage {
  title: string;
  detail: string;
}

/**
 * What went wrong, in words.
 *
 * Specific per kind — being rate-limited is not being offline, and a user who
 * reads "check your connection" while online is being sent to fix a working
 * thing. Never a status code dump, and never the word "Overpass": which
 * service backs the provider is a detail behind the seam, and phase 4 replaces
 * it with a local extract without these sentences becoming lies.
 *
 * `detail` is written to read on its own *and* after "We could not refresh
 * them.", because the stale-results notice reuses it.
 */
const FAILURE_MESSAGES: Record<FailureKey, FailureMessage> = {
  timeout: {
    title: "That took too long",
    detail:
      "The map data service did not answer in time. It is free and shared, so it is sometimes busy.",
  },
  // Genuinely our doing: we asked too often and were told so.
  "rate-limited": {
    title: "Too many requests",
    detail:
      "The map data service has asked us to slow down. Give it a moment before asking again.",
  },
  // Not our doing, and the wording matters: this is the shared instance full
  // of everybody's queries. Blaming the user for opening the app twice would
  // be both wrong and faintly accusatory.
  busy: {
    title: "The map data service is busy",
    detail:
      "It is free for everyone to use, and right now it has no capacity to spare. Trying again in a moment usually works.",
  },
  "network-unavailable": {
    title: "No connection",
    detail:
      "Nothing reached the map data service. Check your signal or your Wi-Fi.",
  },
  "server-error": {
    title: "The map data service is struggling",
    detail:
      "It answered with an error instead of results, which is usually temporary.",
  },
  "request-error": {
    title: "That search was refused",
    detail:
      "The map data service turned the request down, and asking again the same way would not change its mind.",
  },
  "malformed-response": {
    title: "That answer made no sense",
    detail: "The map data service replied with something we could not read.",
  },
};

function failureKey(error: PlaceProviderError): FailureKey {
  if (error.kind !== "http-error") return error.kind;
  return (error.status ?? 0) >= 500 ? "server-error" : "request-error";
}

/**
 * The lookup failed: fail visibly and politely, and offer retry
 * (docs/spec.md §7.6).
 *
 * Exactly one action, and only ever one that can work. `retryable` is the data
 * layer's judgement of whether the identical request could succeed; without a
 * position there is nothing to repeat the request against, and the state
 * machine would drop a retry on the floor. When neither applies, the picker is
 * the only lever the user has left — a different position is a different query.
 */
function failed(
  error: PlaceProviderError,
  hasPosition: boolean,
  hasStaleSpots: boolean,
): StatusContent {
  const key = failureKey(error);
  const { title, detail } = FAILURE_MESSAGES[key];
  const canRetry = error.retryable && hasPosition;
  const actions = [canRetry ? retrySearch() : pick(PICK_POSITION)];
  const signature = `failed:${key}:${canRetry ? "retry" : "pick"}:${hasStaleSpots ? "stale" : "fresh"}`;

  // Results are still on screen. Blanking them for a full-screen apology
  // would take away the answer the user already has, so this presents itself
  // as a caveat on those results instead (docs/spec.md §7.6).
  if (hasStaleSpots) {
    return {
      presence: "notice",
      signature,
      status: "failed",
      title: "These results may be out of date",
      detail: `We could not refresh them. ${detail}`,
      actions,
    };
  }

  return {
    presence: "takeover",
    signature,
    status: "failed",
    title,
    detail,
    actions,
  };
}

function pick(label: string, tone: ActionTone = "primary"): StatusAction {
  return {
    label,
    tone,
    run: (callbacks) => {
      callbacks.onPickPosition();
    },
  };
}

function requestLocation(): StatusAction {
  return {
    label: USE_MY_LOCATION,
    tone: "primary",
    run: (callbacks) => {
      callbacks.onRequestLocation();
    },
  };
}

function retrySearch(): StatusAction {
  return {
    label: TRY_AGAIN,
    tone: "primary",
    run: (callbacks) => {
      callbacks.onRetry();
    },
  };
}

function retryLocation(): StatusAction {
  return {
    label: TRY_AGAIN,
    tone: "secondary",
    run: (callbacks) => {
      callbacks.onRetryLocation();
    },
  };
}

function buildCard(
  content: StatusContent,
  callbacks: StatusCallbacks,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "status-card";
  card.dataset.status = content.status;
  card.dataset.statusTone = content.presence;

  // A paragraph rather than a heading: this is a transient announcement, not a
  // section of the document, and the region is read atomically anyway.
  const title = document.createElement("p");
  title.className = "status-title";
  title.textContent = content.title;
  card.append(title);

  if (content.detail !== undefined) {
    const detail = document.createElement("p");
    detail.className = "status-detail";
    detail.textContent = content.detail;
    card.append(detail);
  }

  if (content.invite) {
    const invite = document.createElement("p");
    invite.className = "status-invite";
    invite.append(createContributionInvitation("dog park"));
    card.append(invite);
  }

  if (content.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "status-actions";
    for (const action of content.actions) {
      actions.append(buildAction(action, callbacks));
    }
    card.append(actions);
  }

  return card;
}

/**
 * Real buttons, in the order they should be reached: the one most likely to
 * help first, for both the thumb and the tab key.
 */
function buildAction(
  action: StatusAction,
  callbacks: StatusCallbacks,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `status-action status-action-${action.tone}`;
  button.textContent = action.label;
  button.addEventListener("click", () => {
    action.run(callbacks);
  });
  return button;
}
