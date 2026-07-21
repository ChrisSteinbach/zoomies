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
 * sentence, improves the commons rather than just this app, and is the whole of
 * what the MVP does about contribution — no tooling.
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
 */
export function createAttribution(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "attribution";

  footer.append(dataCredit(), contributeInvitation());
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

/** The §4.3 note: a missing park is a gap in OSM, and gaps can be filled. */
function contributeInvitation(): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = "attribution-contribute";

  const link = externalLink(OSM_CONTRIBUTE_URL, "add it to OpenStreetMap");

  line.append("Dog park or hundbad missing? ", link, " and everyone gets it.");
  return line;
}

/**
 * A link that leaves the app.
 *
 * Opened in a new tab: this is a PWA holding a session's worth of results and a
 * position the user may have picked by hand, and navigating away would throw
 * all of it away to read a licence page.
 */
function externalLink(href: string, text: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
