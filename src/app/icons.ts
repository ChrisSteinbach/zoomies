// SVG icon factories, ported from tour-guide — hand-made there, shared here,
// kept verbatim so the two projects stay diffable if these ever move into a
// shared library (zoomies-el7). Each returns an <svg> sized to `1em`, so an
// icon inherits its size from the host button's font-size and its colour from
// `currentColor` — no per-site CSS needed.
//
// Only the factories zoomies uses are ported; tour-guide keeps the full set.

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function createSvgRoot(viewBox = "0 0 18 18"): SVGSVGElement {
  return el("svg", {
    width: "1em",
    height: "1em",
    viewBox,
    fill: "currentColor",
    "aria-hidden": "true",
  });
}

export function createSatelliteIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  // Body (solid square) with a small antenna mast + dish on top,
  // flanked by outlined solar panels divided into cells. Tilted so the
  // silhouette reads as "in orbit" rather than a ground-based tower.
  const group = el("g", { transform: "rotate(-25 9 9)" });
  const body = el("rect", {
    x: 6.75,
    y: 6.75,
    width: 4.5,
    height: 4.5,
    rx: 0.4,
  });
  const panel = (x: number) =>
    el("rect", {
      x,
      y: 7.5,
      width: 5,
      height: 3,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1,
    });
  const divider = (x: number) =>
    el("line", {
      x1: x,
      y1: 7.5,
      x2: x,
      y2: 10.5,
      stroke: "currentColor",
      "stroke-width": 1,
    });
  const mast = el("line", {
    x1: 9,
    y1: 6.75,
    x2: 9,
    y2: 4,
    stroke: "currentColor",
    "stroke-width": 1.2,
    "stroke-linecap": "round",
  });
  const dish = el("circle", { cx: 9, cy: 3.25, r: 1.1 });
  group.append(
    panel(0.5),
    divider(2.17),
    divider(3.83),
    panel(12.5),
    divider(14.17),
    divider(15.83),
    body,
    mast,
    dish,
  );
  svg.appendChild(group);
  return svg;
}

export function createMapIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.appendChild(
    el("path", {
      d: "M9 1.5C5.4 1.5 2.5 4.4 2.5 8c0 4.8 6.5 8.5 6.5 8.5s6.5-3.7 6.5-8.5c0-3.6-2.9-6.5-6.5-6.5zm0 8.7a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z",
      "fill-rule": "evenodd",
    }),
  );
  return svg;
}

export function createInfoIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  svg.append(
    el("circle", {
      cx: 9,
      cy: 9,
      r: 7,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.5,
    }),
    el("circle", { cx: 9, cy: 5, r: 1 }),
    el("rect", { x: 8.25, y: 7.5, width: 1.5, height: 6, rx: 0.5 }),
  );
  return svg;
}

export function createCloseIcon(): SVGSVGElement {
  const svg = createSvgRoot();
  const stroke = (x1: number, y1: number, x2: number, y2: number) =>
    el("line", {
      x1,
      y1,
      x2,
      y2,
      stroke: "currentColor",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
    });
  svg.append(stroke(4, 4, 14, 14), stroke(14, 4, 4, 14));
  return svg;
}
