// @vitest-environment jsdom

import { createLoadReport } from "./load-report";
import { markLoad, resetLoadTimeline } from "./load-timeline";

beforeEach(() => {
  resetLoadTimeline();
});

/** A host attached to the document, so it behaves as it would in the app. */
function mount(): HTMLElement {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

describe("createLoadReport, when the URL does not ask for it", () => {
  it("adds nothing to the host and returns null for an empty query string", () => {
    const host = mount();

    const handle = createLoadReport(host, "");

    expect(handle).toBeNull();
    expect(host.childElementCount).toBe(0);
  });

  it("adds nothing to the host and returns null when a different key is present", () => {
    const host = mount();

    const handle = createLoadReport(host, "?other=1");

    expect(handle).toBeNull();
    expect(host.childElementCount).toBe(0);
  });
});

describe("createLoadReport, once mounted", () => {
  it("shows a row for each mark already recorded when it mounts", () => {
    const host = mount();
    markLoad("boot");
    markLoad("first-fix");

    const handle = createLoadReport(host, "?perf");

    expect(host.textContent).toContain("boot");
    expect(host.textContent).toContain("first fix");
    handle?.destroy();
  });

  it("shows a new row when a mark arrives after it has mounted", () => {
    const host = mount();
    const handle = createLoadReport(host, "?perf");

    markLoad("search-started");

    expect(host.textContent).toContain("search sent");
    handle?.destroy();
  });

  it("shows a mark's detail", () => {
    const host = mount();
    markLoad("first-fix", "+/-8 m");

    const handle = createLoadReport(host, "?perf");

    expect(host.textContent).toContain("+/-8 m");
    handle?.destroy();
  });

  it("removes the report from the host on destroy", () => {
    const host = mount();
    const handle = createLoadReport(host, "?perf");

    handle?.destroy();

    expect(host.childElementCount).toBe(0);
  });

  it("does not throw when destroyed a second time", () => {
    const host = mount();
    const handle = createLoadReport(host, "?perf");
    handle?.destroy();

    expect(() => handle?.destroy()).not.toThrow();
  });

  it("does not throw when the copy button is pressed with no clipboard API", () => {
    const host = mount();
    markLoad("boot");
    const handle = createLoadReport(host, "?perf");

    const copyButton = host.querySelector("button");

    expect(() => copyButton?.click()).not.toThrow();
    handle?.destroy();
  });
});
