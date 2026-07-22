// @vitest-environment jsdom

import "./test-dialog-polyfill";
import {
  ODBL_URL,
  OSM_CONTRIBUTE_URL,
  OSM_COPYRIGHT_URL,
  OSM_DATA_CREDIT,
} from "./attribution";
import { createAboutButton, hideAbout, showAbout } from "./about";

function theDialog(): HTMLDialogElement {
  const dialog = document.querySelector<HTMLDialogElement>(
    "dialog.about-dialog",
  );
  if (!dialog) throw new Error("the About dialog should be open");
  return dialog;
}

afterEach(() => {
  hideAbout();
  document.body.replaceChildren();
});

describe("showAbout", () => {
  it("opens a modal dialog carrying the app name and both sections", () => {
    showAbout();

    const dialog = theDialog();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("About Zoomies");
    expect(dialog.querySelector("h2")?.textContent).toBe("Zoomies");
    const headings = Array.from(
      dialog.querySelectorAll(".about-section h3"),
    ).map((h) => h.textContent);
    expect(headings).toEqual(["Data", "Privacy"]);
  });

  it("credits OpenStreetMap by name with links that leave the app safely", () => {
    showAbout();

    const dialog = theDialog();
    expect(dialog.textContent).toContain(OSM_DATA_CREDIT);

    const links = dialog.querySelectorAll<HTMLAnchorElement>("a");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
    }
  });

  it("links the ODbL licence and the fix-the-map page", () => {
    showAbout();

    const hrefs = Array.from(
      theDialog().querySelectorAll<HTMLAnchorElement>("a"),
    ).map((a) => a.getAttribute("href"));

    expect(hrefs).toContain(OSM_COPYRIGHT_URL);
    expect(hrefs).toContain(ODBL_URL);
    expect(hrefs).toContain(OSM_CONTRIBUTE_URL);
  });

  it("does not stack a second dialog when asked to open twice", () => {
    showAbout();
    const first = theDialog();

    showAbout();

    expect(first.isConnected).toBe(false);
    expect(document.querySelectorAll("dialog.about-dialog")).toHaveLength(1);
  });

  it("closes on the X and gives focus back to the trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    showAbout(trigger);
    theDialog().querySelector<HTMLButtonElement>(".about-close")!.click();

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape", () => {
    showAbout();

    // Native <dialog> fires "cancel" on Escape.
    theDialog().dispatchEvent(new Event("cancel"));

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("closes on a backdrop click", () => {
    showAbout();

    // getBoundingClientRect is all zeros in jsdom, so a nonzero coordinate
    // always reads as outside the panel.
    theDialog().dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }),
    );

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("does not close on a click inside the panel", () => {
    showAbout();

    // Bubbles up from a child, so the event's target is the child, not the
    // dialog itself — the same distinction a click inside the rendered panel
    // makes for real.
    theDialog()
      .querySelector("h2")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(document.querySelector("dialog.about-dialog")).not.toBeNull();
  });
});

describe("hideAbout", () => {
  it("closes the dialog when one is open", () => {
    showAbout();

    hideAbout();

    expect(document.querySelector("dialog.about-dialog")).toBeNull();
  });

  it("is safe to call when nothing is open", () => {
    expect(() => hideAbout()).not.toThrow();
  });
});

describe("createAboutButton", () => {
  it("renders a labelled button that calls back on click", () => {
    const onClick = vi.fn();
    const btn = createAboutButton(onClick);

    expect(btn.getAttribute("aria-label")).toBe("About Zoomies");
    expect(btn.title).toBe("About Zoomies");
    expect(btn.classList.contains("about-btn")).toBe(true);

    btn.click();

    expect(onClick).toHaveBeenCalledOnce();
  });
});
