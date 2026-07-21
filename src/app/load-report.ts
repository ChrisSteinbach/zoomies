// An opt-in, on-screen breakdown of the cold-start timeline recorded by
// load-timeline.ts: boot, asking the device for a position, the fix
// arriving, the search going out and coming back, the first result on
// screen.
//
// It exists for exactly one situation: a phone in the field, on mobile data,
// with no USB cable and no desktop devtools to read performance.mark() from.
// Every real user goes through {@link createLoadReport} and gets nothing —
// the check for the query parameter runs first and returns null before
// anything is built, so the common case pays for none of this.

import { loadMarks, onLoadMark } from "./load-timeline";
import type { LoadMilestone } from "./load-timeline";
import "./load-report.css";

/** The query parameter that opts into the report, e.g. `?perf`. */
export const LOAD_REPORT_PARAM = "perf";

export interface LoadReportHandle {
  /** Unsubscribes and removes the element. Safe to call more than once. */
  destroy(): void;
}

/** The words shown for each milestone; see load-timeline.ts for what each one means. */
const MILESTONE_LABELS: Record<LoadMilestone, string> = {
  boot: "boot",
  "watch-started": "asked for location",
  "first-fix": "first fix",
  "search-started": "search sent",
  "search-settled": "data back",
  "first-row": "first row",
};

/** One rendered line: a label, its running total, and its step from the line before it. */
interface ReportRow {
  label: string;
  atMs: number;
  deltaMs: number;
  detail?: string;
}

/**
 * Mount the load-timeline report into `host`, if the URL asks for it.
 *
 * `search` defaults to the page's own `window.location.search` and is a
 * parameter mainly so tests can pass a string instead of relying on jsdom's
 * URL. Returns null — and creates nothing at all — unless the query string
 * carries {@link LOAD_REPORT_PARAM}, which is the whole of how this stays
 * invisible to everyone who did not ask for it.
 */
export function createLoadReport(
  host: HTMLElement,
  search: string = window.location.search,
): LoadReportHandle | null {
  if (!new URLSearchParams(search).has(LOAD_REPORT_PARAM)) return null;

  const aside = document.createElement("aside");
  aside.className = "load-report";
  aside.setAttribute("aria-label", "Load timeline");

  const table = document.createElement("table");
  table.className = "load-report-rows";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "load-report-copy";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", () => {
    copyToClipboard(reportText(buildRows()));
  });

  aside.append(table, copyButton);
  host.append(aside);

  // Marks recorded before mount come from loadMarks() right here; the
  // subscription below is only for whatever happens next. Re-rendering from
  // scratch on every new mark is deliberate: this report exists to be read a
  // handful of times in a field test, not to be fast, so there is nothing to
  // gain from patching individual rows in place.
  function render(): void {
    table.replaceChildren(...buildRows().map(buildRowElement));
  }

  render();
  const unsubscribe = onLoadMark(render);

  // The Navigation Timing rows read live values at render time, and this
  // module runs before DOMContentLoaded has finished — so at mount, "dom
  // ready" is still zero and its row is skipped. Any later mark re-renders it
  // in, but a run that stalls before the next mark (a refused permission
  // stops the timeline at "asked for location") would never show it. One more
  // render once the page has fully loaded settles it either way.
  if (document.readyState !== "complete") {
    window.addEventListener("load", render, { once: true });
  }

  return {
    destroy() {
      unsubscribe();
      window.removeEventListener("load", render);
      aside.remove();
    },
  };
}

/**
 * The rows to show: what Navigation Timing knows about the page load, plus
 * every recorded mark, in the order it all actually happened. Sorted by time
 * rather than by where a row came from, because the categories interleave for
 * real — a module script boots before DOMContentLoaded finishes, and listing
 * it under "dom ready" made the timeline read backwards ("boot (-4ms)").
 *
 * Each row's delta is measured against the row before it, with the implicit
 * row above the first one being the page-open instant itself — so the first
 * row's delta and its running total are the same number.
 */
function buildRows(): ReportRow[] {
  const entries: Array<{ label: string; atMs: number; detail?: string }> = [];

  const nav = navigationTiming();
  if (nav) {
    if (nav.responseEnd > 0) {
      entries.push({ label: "response", atMs: nav.responseEnd });
    }
    if (nav.domContentLoadedEventEnd > 0) {
      entries.push({
        label: "dom ready",
        atMs: nav.domContentLoadedEventEnd,
      });
    }
  }

  for (const mark of loadMarks()) {
    entries.push({
      label: MILESTONE_LABELS[mark.milestone],
      atMs: mark.atMs,
      detail: mark.detail,
    });
  }

  entries.sort((a, b) => a.atMs - b.atMs);

  let previousMs = 0;
  return entries.map((entry) => {
    const deltaMs = entry.atMs - previousMs;
    previousMs = entry.atMs;
    return { ...entry, deltaMs };
  });
}

/**
 * The current navigation's timing entry, but only when it is genuinely a
 * {@link PerformanceNavigationTiming} — jsdom's test environment has no
 * navigation entries at all, and does not even define the constructor, so
 * `instanceof` on an entry it did provide would throw. Checking existence
 * before that comparison keeps this safe there and everywhere else.
 */
function navigationTiming(): PerformanceNavigationTiming | undefined {
  const [entry] = performance.getEntriesByType("navigation");
  if (!entry) return undefined;
  if (typeof PerformanceNavigationTiming === "undefined") return undefined;
  return entry instanceof PerformanceNavigationTiming ? entry : undefined;
}

function buildRowElement(row: ReportRow): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.append(
    cell(row.label, "load-report-label"),
    cell(`${Math.round(row.atMs)}ms`, "load-report-at"),
    cell(`(${formatDelta(row.deltaMs)}ms)`, "load-report-delta"),
    cell(row.detail ?? "", "load-report-detail"),
  );
  return tr;
}

function cell(text: string, className: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

function formatDelta(deltaMs: number): string {
  const rounded = Math.round(deltaMs);
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

/** The same rows the table shows, as plain text, one row per line, tab-separated. */
function reportText(rows: ReportRow[]): string {
  return rows
    .map((row) => {
      const detail = row.detail ? `\t${row.detail}` : "";
      return `${row.label}\t${Math.round(row.atMs)}ms\t(${formatDelta(row.deltaMs)}ms)${detail}`;
    })
    .join("\n");
}

/**
 * Puts `text` on the clipboard, or quietly does not.
 *
 * Two different ways this fails, both handled the same way: a browser with
 * no Clipboard API throws synchronously reaching for `.writeText`, and one
 * that has it may still reject the promise — Safari does this outside a
 * user-gesture context, which a report re-rendering itself can drift into.
 * Either way there is nothing to tell the user beyond "that didn't work",
 * which is not worth a dead-end error state on a debug overlay.
 */
function copyToClipboard(text: string): void {
  try {
    navigator.clipboard?.writeText(text).catch(() => {
      // Refused; see above.
    });
  } catch {
    // No Clipboard API at all; see above.
  }
}
