// The app shell, in a real browser, checked for the one thing the unit suite
// cannot see: what paints on top of what.
//
// Three stacking faults reached a user while 344 jsdom tests said nothing —
// jsdom has no layout, and vitest stubs the stylesheets away entirely. The
// credit bar covered the drawer handle, so a closed drawer could not be
// reopened; the picker and the sheet tied on z-index and the picker lost on
// DOM order, so the only way out of a refused permission opened *behind* the
// sheet and looked like a dead button; and the credit bar was translucent, so
// the list scrolled visibly through it. Naming the shell's stacking order in
// one place (`:root` in src/styles.css) prevents those; this file catches what
// survives prevention — a typo'd `var()` name computing to `auto`, a new
// element landing in the wrong pane.
//
// Nothing here may touch the network. The Overpass answer comes from the
// fixture the unit tests already parse, and every other cross-origin request
// is aborted, so the suite gives the same answer offline as on a train.

import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

/** Central Stockholm — where the fixture's parks are. */
const STOCKHOLM = { latitude: 59.3293, longitude: 18.0686 };

/** The nearest of them, about a kilometre out, so it heads the sorted list. */
const NEAREST_PARK = "Monteliusvägens hundrastgård";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

/** The way out of a refused permission (src/app/status-view.ts). */
const PICK_POSITION = "Set my position on the map";

/** The drawer's handle, by the name a screen reader would find it under. */
const DRAWER_HANDLE = "Show or hide the list of results";

/** The chip that switches the bathing layer on (src/app/layer-toggle.ts). */
const BATHING_CHIP = "Bathing spots";

/** A bathing spot mapped *for* dogs, with nothing said about the season. */
const DESIGNATED_BATHING = "Smedsuddsbadets hundbad";

/** A beach that allows dogs and carries the summer ban as `dog:conditional`. */
const CONDITIONAL_BATHING = "Långholmens strandbad";

/**
 * A day inside the Stockholm beach-ban window (docs/spec.md §4.5.3), which the
 * page's clock is fixed to before it loads.
 *
 * Without it "Dogs banned now" would be an assertion about the wall clock: the
 * bathing tests would pass all summer and start failing on the first of
 * September, in a suite whose whole point is to answer the same way every run.
 */
const IN_BAN_SEASON = new Date("2026-07-15T12:00:00");

/**
 * The same Overpass response the provider's own tests are written against:
 * seven elements, five unique parks — one has no coordinates and one is a
 * duplicate, both deliberately.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../src/app/overpass.fixture.json", import.meta.url),
    "utf8",
  ),
) as { elements: { id: number }[] };

/**
 * Wide enough apart that no two copies of the fixture can land on the same id.
 * The largest id in it is a ten-digit node.
 */
const ID_STRIDE = 100_000_000_000;

/**
 * The bathing layer's answer, written out here rather than taken from a
 * fixture: these two spots exist to produce two specific captions, and what
 * makes them do it — one tagged for dogs with nothing said about the season,
 * one whose `dog:conditional` bans dogs across the summer — has to be readable
 * beside the test that asserts on those captions.
 *
 * Both sit a couple of kilometres west of {@link STOCKHOLM}, so they land in
 * the same list as the fixture's parks and sort among them.
 */
const BATHING_BODY = JSON.stringify({
  version: 0.6,
  elements: [
    {
      type: "node",
      id: 4001,
      lat: 59.3245,
      lon: 18.0271,
      tags: {
        leisure: "bathing_place",
        dog: "designated",
        name: DESIGNATED_BATHING,
      },
    },
    {
      type: "node",
      id: 4002,
      lat: 59.3213,
      lon: 18.0296,
      tags: {
        natural: "beach",
        dog: "yes",
        name: CONDITIONAL_BATHING,
        "dog:conditional": "no @ (Jun 1-Aug 31)",
      },
    },
  ],
});

interface Point {
  x: number;
  y: number;
}

/**
 * Answer the app's Overpass query from the fixture, and let nothing else off
 * this machine.
 *
 * A catch-all rather than a route per host: the invariant is that a test can
 * never depend on the internet, and listing today's hosts would quietly stop
 * covering tomorrow's. Map tiles and Nominatim are aborted along with
 * everything else — Leaflet draws a grey grid without its tiles and carries
 * on, which is all a stacking test needs from a map.
 *
 * `copies` repeats the fixture's parks, each copy with ids of its own so the
 * provider keeps them apart (identity is `type/id`). Five parks make a list
 * shorter than any viewport here, and an invariant about the *last* row needs
 * one long enough to scroll under the credit bar.
 *
 * Both layers post to the same endpoint, so which one is asking is read off
 * the query itself. Routing on the question rather than on call order matters:
 * the layers search independently and expand their radius independently, so
 * neither the order nor the number of requests is fixed.
 */
async function stubNetwork(
  context: BrowserContext,
  { copies = 1 } = {},
): Promise<void> {
  const body = JSON.stringify({
    ...FIXTURE,
    elements: Array.from({ length: copies }, (_, copy) =>
      FIXTURE.elements.map((element) => ({
        ...element,
        id: element.id + copy * ID_STRIDE,
      })),
    ).flat(),
  });

  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return route.continue();
    }
    if (`${url.origin}${url.pathname}` === OVERPASS_ENDPOINT) {
      // The bathing union carries the `hundbad` name regex and the dog-park
      // query does not (src/app/overpass.ts).
      const asked = route.request().postData() ?? "";
      return route.fulfill({
        contentType: "application/json",
        body: asked.includes("hundbad") ? BATHING_BODY : body,
      });
    }
    return route.abort();
  });
}

/**
 * What the browser would actually hit at `point`: the element on top, then its
 * ancestors out to the document.
 *
 * "The row is in the DOM" and "the row is what your thumb lands on" are
 * different claims, and only the second one is a stacking invariant — so these
 * assertions go through `elementFromPoint` rather than through the DOM. The
 * whole chain, rather than just the top element, is for the failure message:
 * it names whatever did the covering instead of only reporting that the target
 * lost.
 */
async function stackAt(page: Page, point: Point): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const describe = (element: Element): string => {
      // getAttribute, not `.className`: on an SVG element that property is an
      // object, and the drawer handle's icon is an SVG.
      const classes = element.getAttribute("class")?.trim();
      const suffix = classes ? `.${classes.split(/\s+/).join(".")}` : "";
      return `${element.tagName.toLowerCase()}${suffix}`;
    };

    const chain: string[] = [];
    for (
      let element: Element | null = document.elementFromPoint(x, y);
      element !== null;
      element = element.parentElement
    ) {
      chain.push(describe(element));
    }

    return chain.join(" < ") || "nothing";
  }, point);
}

/** The middle of an element, in viewport coordinates. */
async function centreOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("the element has no box, so it is not on screen at all");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("with the device's position shared", () => {
  test.use({ permissions: ["geolocation"], geolocation: STOCKHOLM });

  test("the nearest park heads the result list", async ({ context, page }) => {
    await stubNetwork(context);
    await page.goto("/");

    // The harness's own sanity check: a granted permission and a stubbed
    // Overpass really do land on results. Everything below assumes it.
    const firstRow = page.locator(".spot-list-item").first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow).toContainText(NEAREST_PARK);
  });

  test("a closed drawer can be reopened", async ({ context, page }) => {
    await stubNetwork(context);
    await page.goto("/");

    const handle = page.getByRole("button", { name: DRAWER_HANDLE });
    const firstRow = page.locator(".spot-list-item").first();
    await expect(firstRow).toBeVisible();

    // Both clicks are hit tests in their own right: Playwright refuses to
    // click through anything covering the handle.
    await handle.click();
    await expect(handle).toHaveAttribute("aria-expanded", "false");
    await expect(firstRow).not.toBeInViewport();

    // A closed drawer is nothing but its handle, so anything painting over it
    // is a one-way door. The credit bar did exactly that.
    expect(await stackAt(page, await centreOf(handle))).toContain(
      ".spot-drawer-handle",
    );

    await handle.click();
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await expect(firstRow).toBeInViewport();
  });

  test("the last row is not behind the credit bar", async ({
    context,
    page,
  }) => {
    await stubNetwork(context, { copies: 10 });
    await page.goto("/");

    const rows = page.locator(".spot-list-item");
    await expect(rows.first()).toBeVisible();

    // Scrolled to its end, and long enough that there *is* an end to scroll to
    // — a list that stops short of the credit bar cannot be hidden behind it,
    // so without this the assertions below would hold for the wrong reason.
    const overflow = await page
      .locator(".spot-drawer-content")
      .evaluate((content) => {
        content.scrollTop = content.scrollHeight;
        return content.scrollHeight - content.clientHeight;
      });
    expect(overflow).toBeGreaterThan(0);

    const lastRow = rows.last();
    const rowBox = await lastRow.boundingBox();
    const creditBox = await page.locator("footer.attribution").boundingBox();
    if (rowBox === null || creditBox === null) {
      throw new Error("the row and the credit bar should both be on screen");
    }

    // The sheet reserves room from the bar's own `offsetHeight`, which is
    // rounded to a whole pixel, so the last row can end a fraction of one
    // below the bar's top edge. Losing the reserve puts it tens of pixels
    // under.
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(creditBox.y + 1);

    expect(await stackAt(page, await centreOf(lastRow))).toContain(
      ".spot-list-item",
    );
  });

  test("the mode toggle swaps to a picked spot and back to the GPS", async ({
    context,
    page,
  }) => {
    await stubNetwork(context);
    await page.goto("/");
    await expect(page.locator(".spot-list-item").first()).toBeVisible();

    // Following the device: the GPS side is pressed, and both clicks below
    // are hit tests — a sticky header that slid under something would fail
    // them, which is what makes this a stacking test and not just a flow.
    await expect(
      page.getByRole("button", { name: "Following your location" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page
      .getByRole("button", { name: "Choose a spot on the map" })
      .click();
    await expect(page.locator(".app-picker")).toBeVisible();
    await page.locator(".map-picker-map").click();
    await page.getByRole("button", { name: "Use this location" }).click();

    // Now hand-picked: the pin side is pressed and the GPS side offers the
    // way back.
    await expect(
      page.getByRole("button", { name: "Choose a different spot on the map" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Follow my location" }).click();

    // The permission is granted, so the resumed watch gets its fix and the
    // toggle settles back on the GPS side, results still on screen.
    await expect(
      page.getByRole("button", { name: "Following your location" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".spot-list-item").first()).toBeVisible();
  });

  test("the credit bar stays on top of the results", async ({
    context,
    page,
  }) => {
    await stubNetwork(context);
    await page.goto("/");
    await expect(page.locator(".spot-list-item").first()).toBeVisible();

    // Visible attribution is an ODbL obligation (docs/spec.md §4.1), so it is
    // not enough for the bar to be in the document: it has to be the thing on
    // screen at its own centre.
    const credit = page.locator("footer.attribution");
    await expect(credit).toBeVisible();
    expect(await stackAt(page, await centreOf(credit))).toContain(
      "footer.attribution",
    );
  });
});

/**
 * The bathing layer, end to end (docs/spec.md §4.3).
 *
 * Not a stacking test like the rest of this file, and here for a different
 * reason: what a bathing row says is a safety claim, and the wording of it is
 * decided by a date. jsdom can be handed a date; only a browser can be handed
 * a *clock*, a real toggle and a rendered list at once, and be asked whether
 * the sentence a user actually reads in July is the right one.
 */
test.describe("with the bathing layer", () => {
  test.use({ permissions: ["geolocation"], geolocation: STOCKHOLM });

  /** The row for a spot, found the way a reader finds it: by its name. */
  function rowFor(page: Page, name: string): Locator {
    return page.locator(".spot-list-item").filter({ hasText: name });
  }

  /** A loaded app with results on screen and the clock inside the ban window.
   *  The clock is set before the first navigation, so nothing the page ever
   *  runs sees the real date. */
  async function openWithResults(
    context: BrowserContext,
    page: Page,
  ): Promise<Locator> {
    await stubNetwork(context);
    await page.clock.setFixedTime(IN_BAN_SEASON);
    await page.goto("/");

    await expect(rowFor(page, NEAREST_PARK)).toBeVisible();
    return page.getByRole("button", { name: BATHING_CHIP });
  }

  test("the bathing layer folds into the one list", async ({
    context,
    page,
  }) => {
    const chip = await openWithResults(context, page);

    await chip.click();

    // One list, distance-sorted, holding both layers — not a second list and
    // not a filter that hides the parks.
    await expect(rowFor(page, DESIGNATED_BATHING)).toBeVisible();
    await expect(rowFor(page, CONDITIONAL_BATHING)).toBeVisible();
    await expect(rowFor(page, NEAREST_PARK)).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  test("a bathing spot says what the data supports", async ({
    context,
    page,
  }) => {
    const chip = await openWithResults(context, page);

    await chip.click();

    // OSM said nothing about this one's season, and saying nothing is not
    // permission (docs/spec.md §4.5.3).
    await expect(rowFor(page, DESIGNATED_BATHING)).toContainText(
      "Verify signage on site",
    );
    // This one carries the ban, and the page's clock is standing in the middle
    // of it. The caption a user reads today has to say so today.
    await expect(rowFor(page, CONDITIONAL_BATHING)).toContainText(
      "Dogs banned now (1 Jun – 31 Aug)",
    );
  });

  test("toggling off takes the layer out", async ({ context, page }) => {
    const chip = await openWithResults(context, page);

    await chip.click();
    await expect(rowFor(page, DESIGNATED_BATHING)).toBeVisible();

    await chip.click();

    await expect(rowFor(page, DESIGNATED_BATHING)).toHaveCount(0);
    await expect(rowFor(page, CONDITIONAL_BATHING)).toHaveCount(0);
    // The parks were never the bathing layer's to remove.
    await expect(rowFor(page, NEAREST_PARK)).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
  });
});

// No permission is granted here, which the browser answers with an outright
// denial — the same dead end as tapping "Block", and the state the picker
// exists to rescue.
test.describe("with location sharing refused", () => {
  test("the picker opens on top of the sheet", async ({ context, page }) => {
    await stubNetwork(context);
    await page.goto("/");

    await page.getByRole("button", { name: PICK_POSITION }).click();

    const picker = page.locator(".app-picker");
    await expect(picker).toBeVisible();

    const viewport = page.viewportSize();
    if (viewport === null) {
      throw new Error("these projects all set a viewport");
    }
    expect(
      await stackAt(page, {
        x: viewport.width / 2,
        y: viewport.height / 2,
      }),
    ).toContain(".app-picker");

    // On top *and* taking the taps: choosing a spot on the picker's map is
    // what arms the confirm button, and it was the sheet that swallowed those
    // taps while the picker opened behind it.
    await page.locator(".map-picker-map").click();
    await expect(
      page.getByRole("button", { name: "Use this location" }),
    ).toBeEnabled();
  });

  test("the credit bar stays on top of the status", async ({
    context,
    page,
  }) => {
    await stubNetwork(context);
    await page.goto("/");

    // The phase with no map at all, where the sheet is at its largest — an
    // earlier credit bar sat under it and vanished exactly here.
    await expect(page.getByText(PICK_POSITION)).toBeVisible();

    const credit = page.locator("footer.attribution");
    await expect(credit).toBeVisible();
    expect(await stackAt(page, await centreOf(credit))).toContain(
      "footer.attribution",
    );
  });
});
