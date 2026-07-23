// Crediting OpenStreetMap (docs/spec.md §4.1).
//
// ODbL requires *visible* attribution wherever the data is used, so this is a
// licensing obligation and not a piece of decoration — nothing here may be
// hidden to tidy up a layout.
//
// Two separate surfaces carry it, and they are easy to confuse:
//
//   1. The map tiles. Leaflet draws a credit in the corner of each map from
//      the string it is handed; every map in the app must hand it the same
//      one ({@link OSM_TILE_ATTRIBUTION}).
//   2. The place data underneath. That obligation does not lapse when no map
//      is on screen — the `empty` and `failed` phases show a list or a message
//      and no map at all, and the results were still OSM's. That is what
//      {@link createAttribution} is for: it belongs in the app chrome,
//      *outside* whatever region the phases swap, so no phase can switch it
//      off.
//
// Every string lives here so there is one place to get them right.

/** OSM's own page explaining the licence and how to credit it. */
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/**
 * OSM's "the map is wrong, here is how to fix it" page.
 *
 * The honest answer to a missing dog park or hundbad is that OSM does not know
 * about it yet, and the fix is to add it (docs/spec.md §4.3). Saying so costs a
 * sentence — the About dialog (about.ts) says it, and the empty and thin
 * answers say it at the moment the gap is on screen
 * ({@link createContributionInvitation}) — improves the commons rather than
 * just this app, and is the whole of what the MVP does about contribution:
 * no tooling.
 */
export const OSM_CONTRIBUTE_URL = "https://www.openstreetmap.org/fixthemap";

/** The licence the place data is under. */
export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/";

/**
 * The credit line ODbL asks for, verbatim (docs/spec.md §4.1).
 *
 * Exported so any surface that needs to say it says it the same way.
 */
export const OSM_DATA_CREDIT = "© OpenStreetMap contributors";

/**
 * What Leaflet renders in the corner of a map, for the *tiles*.
 *
 * HTML rather than text because that is the format Leaflet's attribution
 * control takes. Hand this to every `L.tileLayer` in the app: the picker's map
 * and the results map credit the tiles in identical words, and this is the one
 * place to change them.
 */
export const OSM_TILE_ATTRIBUTION = `&copy; <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap</a> contributors`;

/**
 * The data attribution, as a standalone element for the app chrome.
 *
 * Takes no arguments on purpose. There is no state it can be given and
 * therefore no phase — `locating`, `ready`, `empty`, `failed` — that can render
 * it differently or not at all. Mount it once, next to the region the phases
 * render into rather than inside it, and the obligation is met for the whole
 * session.
 *
 * One line, and only the line the licence asks for. The fuller story — the
 * invitation to map a missing park, the privacy note, the caveats — lives in
 * the About dialog (about.ts), a tap away behind the ⓘ button. The credit is
 * the one piece that may not retreat behind a tap, so it is the one piece
 * that stays pinned.
 */
export function createAttribution(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "attribution";

  footer.append(dataCredit());
  return footer;
}

/** "Place data © OpenStreetMap contributors, licensed ODbL." */
function dataCredit(): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = "attribution-data";

  const credit = externalLink(OSM_COPYRIGHT_URL, OSM_DATA_CREDIT);
  const licence = externalLink(ODBL_URL, "ODbL");

  line.append("Place data ", credit, ", licensed ", licence, ".");
  return line;
}

/**
 * A link that leaves the app.
 *
 * Opened in a new tab: this is a PWA holding a session's worth of results and a
 * position the user may have picked by hand, and navigating away would throw
 * all of it away to read a licence page. Shared by every surface that links
 * out — the credit line, the About dialog, the contribution invitation — so
 * none of them can forget that.
 */
export function externalLink(href: string, text: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

/**
 * The invitation to fix a data gap: "Know a bathing spot that’s missing?
 * Add it to OpenStreetMap."
 *
 * "Fewer results rather than confident wrong ones" (docs/spec.md §3) leaves
 * the app honest but empty-handed exactly where OSM is thin, and §4.3 says
 * the long-term fix — the user adding the missing place — is worth naming in
 * the UI. This is that sentence, rendered at the one moment it can land:
 * when an answer has just come back empty or far, and the reader is looking
 * at a gap they may personally know how to fill.
 *
 * A span rather than a paragraph so it can sit inside an existing note's
 * live region and be announced together with the finding it follows from, or
 * be wrapped in a block of its own by a card with more room.
 */
export function createContributionInvitation(subject: string): HTMLElement {
  const line = document.createElement("span");
  line.className = "contribute-invitation";
  line.append(
    `Know a ${subject} that’s missing? `,
    externalLink(OSM_CONTRIBUTE_URL, "Add it to OpenStreetMap"),
    ".",
  );
  return line;
}
