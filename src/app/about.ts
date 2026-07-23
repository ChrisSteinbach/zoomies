// The About dialog: names the app, credits OpenStreetMap for the data, and
// says what happens to a position once one is given. Mechanics ported from
// tour-guide's about.ts — a native <dialog> created on demand and appended
// to document.body, a module-level teardown singleton so a second open never
// stacks, and three ways out (the X, Escape, a backdrop click) that all
// collapse to that one teardown. The copy below is zoomies' own.
//
// It lives here rather than in state-machine.ts because opening it changes
// nothing about position or results — the machine has no phase, no event,
// and nothing to decide while it's open. The same reasoning keeps the
// drawer's open/close out of the machine (see spot-drawer.ts): chrome that
// doesn't change what the app is doing isn't the machine's business.

import {
  externalLink,
  ODBL_URL,
  OSM_CONTRIBUTE_URL,
  OSM_COPYRIGHT_URL,
  OSM_DATA_CREDIT,
} from "./attribution";
import { createCloseIcon, createInfoIcon } from "./icons";

let activeTeardown: (() => void) | null = null;

/** Close the About dialog if it's open. Safe to call when it is not. */
export function hideAbout(): void {
  activeTeardown?.();
  activeTeardown = null;
}

/** The data section: where the places come from, and how to fix a gap. */
function buildDataSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "about-section";

  const heading = document.createElement("h3");
  heading.textContent = "Data";

  const credit = document.createElement("p");
  credit.append(
    "Place data ",
    externalLink(OSM_COPYRIGHT_URL, OSM_DATA_CREDIT),
    ", licensed ",
    externalLink(ODBL_URL, "ODbL"),
    ". Map tiles are OpenStreetMap's too, credited in the corner of every map.",
  );

  const contribute = document.createElement("p");
  contribute.append(
    "Dog park or hundbad missing? ",
    externalLink(OSM_CONTRIBUTE_URL, "add it to OpenStreetMap"),
    " and everyone gets it. Coverage is uneven — this app would rather show fewer places than invented ones.",
  );

  section.append(heading, credit, contribute);
  return section;
}

/** The privacy section: what leaves the browser tab, and how to stop it. */
function buildPrivacySection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "about-section";

  const heading = document.createElement("h3");
  heading.textContent = "Privacy";

  const stays = document.createElement("p");
  stays.textContent =
    "Your position stays in this browser tab. It is sent only as the centre of each search to the map data services, and it is never stored or shared beyond that.";

  const revoke = document.createElement("p");
  revoke.textContent =
    "You can turn location off for this site in your browser settings at any time and set your position by hand on the map instead.";

  section.append(heading, stays, revoke);
  return section;
}

/** Open the About dialog. `trigger` gets focus back on close. */
export function showAbout(trigger?: HTMLElement): void {
  hideAbout(); // a second open tears down the first rather than stacking

  const dialog = document.createElement("dialog");
  dialog.className = "about-dialog";
  dialog.setAttribute("aria-label", "About Zoomies");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "about-close";
  close.setAttribute("aria-label", "Close");
  close.appendChild(createCloseIcon());

  const title = document.createElement("h2");
  title.textContent = "Zoomies";

  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent = "Find somewhere for your dog to run.";

  dialog.append(
    close,
    title,
    tagline,
    buildDataSection(),
    buildPrivacySection(),
  );
  document.body.appendChild(dialog);
  dialog.showModal();

  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    activeTeardown = null;
    dialog.close();
    dialog.remove();
    if (trigger?.isConnected) trigger.focus();
  };
  activeTeardown = teardown;

  close.addEventListener("click", teardown);

  // Native <dialog> fires "cancel" on Escape before it would close itself —
  // pre-empt that default so this teardown runs instead, and the dialog
  // never closes by any path that skips it.
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    teardown();
  });

  // A click on ::backdrop is reported as a click on the dialog element
  // itself, with coordinates outside its box. A click on the panel instead
  // targets whatever child renders there, so it never reaches this branch.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const insidePanel =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!insidePanel) teardown();
  });
}

/** The ⓘ button for the app chrome. */
export function createAboutButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "about-btn";
  btn.setAttribute("aria-label", "About Zoomies");
  btn.title = "About Zoomies";
  btn.appendChild(createInfoIcon());
  btn.addEventListener("click", onClick);
  return btn;
}
