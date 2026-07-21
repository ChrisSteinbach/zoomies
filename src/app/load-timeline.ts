// A recorder for the page's one cold start (see load-report.ts, which reads
// it back).
//
// The state here is module-level rather than threaded through the app as a
// dependency. A page loads exactly once, so there is exactly one timeline to
// record — passing a recorder into every layer that might reach a milestone
// would be ceremony around a value that is global by nature, not a design
// choice with a real alternative. And nothing in the app ever branches on
// what this module holds: it is written to by app logic as milestones pass,
// and read only by the opt-in report. That asymmetry is what keeps module
// state safe here — there is no code whose behaviour depends on reading it
// back, so there is nothing for hidden state to break.

export type LoadMilestone =
  | "boot" // the app's JS started running
  | "watch-started" // we asked the device where it is
  | "first-fix" // the device answered
  | "search-started" // the first place query went out
  | "search-settled" // that query came back, either way
  | "first-row"; // the first result was on screen

export interface LoadMark {
  milestone: LoadMilestone;
  /** Milliseconds since the page was opened. */
  atMs: number;
  /** What made this one interesting, e.g. "+/-8 m", "6 spots", "busy". */
  detail?: string;
}

type Listener = (mark: LoadMark) => void;

let marks: LoadMark[] = [];
let listeners: Listener[] = [];

/**
 * Record that `milestone` has happened, at `performance.now()` — milliseconds
 * since navigation start, which is what "since the user opened the app" means
 * for a page that is never reloaded in place.
 *
 * First write per milestone wins. This is the timeline of *one* cold start:
 * a second GPS fix or a follow-up search calling this again with the same
 * milestone is a repeat, not a correction, and recording it would overwrite
 * the very number the report exists to show. So a repeat is dropped
 * entirely — no mark, no listener call — rather than kept as a latest value.
 */
export function markLoad(milestone: LoadMilestone, detail?: string): void {
  if (marks.some((mark) => mark.milestone === milestone)) return;

  const mark: LoadMark = { milestone, atMs: performance.now(), detail };
  marks.push(mark);
  mirrorToUserTiming(milestone);

  for (const listener of listeners) {
    try {
      listener(mark);
    } catch {
      // A broken listener is that listener's problem. It must not cost the
      // mark itself, which is already recorded above, or any other listener
      // still waiting to hear about it.
    }
  }
}

/** The marks recorded so far, in the order they happened. */
export function loadMarks(): readonly LoadMark[] {
  return [...marks];
}

/**
 * Hear about marks recorded from now on. Returns a function that stops the
 * listening.
 *
 * Deliberately does not replay history: a caller that wants what already
 * happened reads {@link loadMarks} once, at mount, and this is only for what
 * happens next. Splitting it this way means a listener is never called twice
 * for the same mark, whichever order a caller does the two calls in.
 */
export function onLoadMark(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((candidate) => candidate !== listener);
  };
}

/**
 * Clears every mark and listener.
 *
 * Exists for tests. A real page loads once, so nothing in the running app
 * ever needs to rewind this clock — only a test suite reusing one process
 * across cases does.
 */
export function resetLoadTimeline(): void {
  marks = [];
  listeners = [];
}

/**
 * Mirrors a mark onto the User Timing API, so a session with a cable and
 * devtools attached sees the same timeline as the on-screen report, in the
 * same performance panel as everything else on the page.
 *
 * A nicety, not a dependency: nothing here may throw back into the app that
 * is trying to measure itself, so both the feature check and the call are
 * wrapped away.
 */
function mirrorToUserTiming(milestone: LoadMilestone): void {
  try {
    if (typeof performance.mark === "function") {
      performance.mark(`zoomies:${milestone}`);
    }
  } catch {
    // See above: a failed devtools mirror is not this module's problem.
  }
}
