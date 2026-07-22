import type { LatLon } from "./types";
import type { Ring } from "./coverage";
import { pointInRing } from "./coverage";

/**
 * A coarse confidence signal for one decision: how hard should the UI hedge
 * when a query comes back with no dog parks?
 *
 * docs/spec.md §4.5.1: `leisure=dog_park` tagging is dense and trustworthy
 * in Stockholm, Scandinavia, Germany, the US, Canada, the UK, Ireland,
 * Australia and New Zealand, and sparse everywhere else. An empty result from a dense region probably means
 * there really are no dog parks nearby; the same empty result from a sparse
 * region probably means nobody has mapped them yet. The UI needs to tell
 * those two silences apart, and this module is the only thing that knows
 * how.
 *
 * The rings below are a coarse confidence heuristic, not a boundary claim.
 * Nothing here asserts a national border and nothing downstream should read
 * one into it — they exist only to answer "does the map probably have data
 * near here", at the resolution that question deserves: hand-drawn,
 * city-scale, sea-tolerant.
 *
 * That resolution is chosen for a specific asymmetry, not for laziness.
 * Marking a sparse place dense is the bad direction: it turns "nobody has
 * mapped this" into "the map confidently has nothing here", the exact
 * confidently-wrong answer docs/spec.md §3 forbids. Marking a dense place
 * sparse is cheap: it just makes the UI hedge harder than a good dataset
 * warrants, an over-strong caveat where a milder one would have done.
 * Every ring below is drawn to err toward sparse as a result: it stays
 * inside the land borders of the region it covers; it is free to spill into
 * sea, because nobody's GPS answers from open water; it must never enclose
 * land of a country not on the §4.5.1 list, even at city scale, because
 * that is exactly the bad-direction mistake; and losing a rural sliver of a
 * listed country's own border is an accepted, cheap cost, not a bug.
 *
 * Rings are [lat, lon] pairs, latitude first — the app's convention and the
 * opposite of GeoJSON's, and getting it backwards here is exactly as silent
 * and catastrophic as coverage.ts's Ring docstring describes for the
 * offline dataset. Say "lat, lon" out loud when adding a vertex. Containment
 * reuses {@link pointInRing} unchanged: same ray cast, same
 * antimeridian-and-poles caveat — no vertex may sit at ±180 or beyond, and
 * no ring may straddle the antimeridian. That caveat bites twice here:
 * ALASKA below is boxed in from the antimeridian side rather than wrapped
 * across it, and NEW_ZEALAND stops at 179E, leaving the Chatham Islands on
 * the far side.
 *
 * The near-neighbours still sparse are strict readings, not oversights:
 * Iceland and the Isle of Man (see NORDICS and GREAT_BRITAIN), Greenland,
 * and St-Pierre-et-Miquelon — France, one boat-hop off Newfoundland, and
 * the one place that forces NEWFOUNDLAND below to hold a genuinely sharp
 * edge. This module encodes §4.5.1 as written; when the list moved —
 * Canada, Ireland and New Zealand joined it — the rings moved with it,
 * not ahead of it.
 */

/** Whether OSM's dog-park layer is dense enough near a position to read an
 *  empty result as "probably no dog parks" rather than "probably unmapped". */
export type MappingDensity = "dense" | "sparse";

/**
 * Sweden, Norway, Denmark, and mainland Finland as one ring: the spec's
 * "Stockholm, Scandinavia" (§4.5.1) is read here as the Nordic mainland
 * including Finland — Finland's dog-park tagging is comparable to its
 * neighbours', and a Swedish-authored spec reaching for "Scandinavia" reads
 * as reaching for the whole region colloquially, not the strict
 * three-country sense. Iceland is read strictly and stays sparse: it is
 * genuinely thinner ground, and the colloquial reading doesn't stretch that
 * far anyway.
 *
 * The internal seams between the four countries need no precision — the
 * ring crosses the Kattegat and Skagerrak (Denmark/Sweden/Norway) and the
 * Gulf of Bothnia (Sweden/Finland) freely, all open sea between dense
 * neighbours. The same is true where this ring's southern edge meets
 * GERMANY's own: Germany is dense too, so overlap at that seam costs
 * nothing.
 *
 * Two edges are drawn with real care, both separating a dense city from a
 * sparse one a short hop away:
 *  - The Gulf of Finland: Helsinki (60.17N) sits comfortably north of the
 *    cut, Tallinn (59.44N) comfortably south of it, and the boundary runs
 *    the water between them at roughly 59.8N rather than hugging either
 *    shore.
 *  - Russia: St Petersburg and the Kola peninsula stay out by running the
 *    eastern edge near Finland's real border, roughly 28-31E, rather than
 *    tracing it exactly — a rural sliver lost here and there is the
 *    accepted cost of that shortcut.
 * The east coast bulges out to sea past the Stockholm archipelago rather
 * than hugging the mainland shore: spilling into the Baltic is free, and
 * hugging tighter would have clipped Stockholm itself.
 */
const NORDICS: Ring = [
  [54.8, 8.2],
  [57.8, 8.0],
  [58.9, 5.0],
  [60.5, 4.3],
  [63.5, 8.0],
  [67.3, 12.5],
  [69.8, 16.5],
  [71.0, 25.0],
  [69.8, 30.0], // Norway/Russia border near Kirkenes — Kola stays out.
  [66.0, 29.5],
  [62.0, 30.5],
  [61.0, 28.5], // Karelian isthmus: the border swings hard west below here —
  [60.55, 27.7], // Lappeenranta and Hamina stay in, Vyborg and Svetogorsk out.
  [59.8, 24.9], // Gulf of Finland cut: Helsinki north, Tallinn south of this.
  [59.5, 20.5],
  [59.0, 19.5], // Bulged east of Stockholm's own longitude, into the sea.
  [57.5, 19.2],
  [56.0, 16.0],
  [55.2, 12.6],
];

/**
 * Germany needs an actual polygon, not the tempting shortcut: its bounding
 * box reaches south and east far enough to swallow Prague (50.09N, 14.42E)
 * whole, which is exactly the bad-direction mistake this module exists to
 * avoid. The ring below traces the real border closely enough to keep every
 * neighbour's near-side city out while keeping every German one in:
 *  - West (Netherlands/Belgium), roughly 6-7E: Cologne (6.96E) and Aachen
 *    are in, Amsterdam and Brussels comfortably clear — and the chain
 *    notches east around the Dutch Twente bulge, which pokes past 7E and
 *    would otherwise ride in with Enschede aboard.
 *  - Southwest (France), along the Rhine: Strasbourg is out and Freiburg is
 *    in, though the two sit only ~0.1° apart — about as fine an edge as a
 *    hand-drawn ring can hold without a vertex placed specifically for it.
 *  - South (Switzerland): Basel is out, Munich well in.
 *  - Southeast (Austria): the border notches north around Salzburg to keep
 *    it out, which loses the small German pocket around Berchtesgaden east
 *    of it — an accepted cost rather than a vertex spent chasing one town.
 *  - Southeast (Czechia): Prague is out and Dresden is in, with the
 *    Ore-mountain stretch between them drawn with enough margin that
 *    neither is a near thing.
 *  - East (Poland): the border sits at only ~14.3E up by Szczecin
 *    (14.55E), so the northeast corner is drawn tight there rather than at
 *    the wider box a casual glance at the map would suggest.
 */
const GERMANY: Ring = [
  [54.0, 8.6],
  [54.5, 13.3],
  [53.3, 14.2], // Szczecin (14.55E) stays out — the border here is ~14.3E.
  [52.3, 14.6],
  [51.2, 15.0],
  [50.9, 14.8],
  [50.5, 13.0], // Ore-mountain stretch: Dresden north, Prague south of it.
  [50.3, 12.2],
  [48.8, 13.3],
  [48.0, 12.9], // Notches north of Salzburg; Berchtesgaden is lost east of it.
  [47.6, 12.2],
  [47.4, 11.0],
  [47.55, 9.0],
  [47.65, 7.6], // Basel tripoint area — Basel itself stays out.
  [47.9, 7.8], // Rhine, just east of Freiburg (7.85E).
  [48.6, 7.8], // Rhine, just west of Strasbourg (7.75E) at its latitude.
  [49.5, 6.4],
  [50.75, 6.0], // Aachen tripoint: Aachen in, Maastricht out.
  [51.7, 6.3],
  [52.0, 7.2], // Dutch Twente pokes east past 7E — Enschede stays out.
  [52.5, 7.1],
  [53.35, 7.05], // Ems mouth: Emden in, Delfzijl across the river out.
];

/**
 * Great Britain only — Northern Ireland rides with IRELAND below, which
 * wraps the whole island now that both of its countries are on §4.5.1's
 * list; this ring predates that and never needed redrawing. The Isle of
 * Man, a Crown dependency on neither list, sits between the two rings and
 * reads sparse — the strict reading, kept deliberately. The southeast
 * corner is drawn to keep Calais and the French coast clear of the Channel
 * crossing rather than hugging the English shore.
 */
const GREAT_BRITAIN: Ring = [
  [50.0, -5.7],
  [51.2, -5.5],
  [51.6, -4.0],
  [51.3, -3.4],
  [51.6, -3.2],
  [53.4, -3.6],
  [54.6, -3.6], // North of here is Scotland; Northern Ireland stays unwrapped.
  [54.9, -5.1],
  [55.8, -5.6],
  [58.7, -5.2],
  [58.7, -3.0],
  [57.7, -1.8],
  [55.8, -1.5],
  [53.5, 0.5],
  [52.0, 1.8], // Southeast corner, short of Calais across the Channel.
  [51.0, 1.5],
  [50.8, 0.9], // Holds the corner out to sea past Hastings and Eastbourne,
  // which a straight run for Cornwall would have clipped off.
];

/**
 * The Lower 48, with one border that still needs real care — Mexico — and
 * one that used to:
 *  - North (Canada): drawn along the 49th parallel and the Great Lakes
 *    back when Canada was off the list and this was the module's longest
 *    bad-direction frontier. Canada is dense now and CANADA_MAINLAND
 *    overlaps this edge from the north, so the seam is as free as the
 *    Nordics/Germany one — the precision here is harmless history, kept
 *    because redrawing a tested border buys nothing.
 *  - South (Mexico), the Pacific end: San Diego is in, Tijuana is out, a
 *    gap that needed its vertex placed with more care than the rest of this
 *    ring holds — see the inline comment below. From there east the chain
 *    follows the border's real staircase along the Imperial valley and the
 *    Colorado river, because a straight line to the Rio Grande would pass
 *    south of Mexicali and quietly hand a city of a million the wrong
 *    verdict. East of the Arizona/New Mexico line the border follows the
 *    Rio Grande's general diagonal rather than its actual bends, which is
 *    coarser and loses any city sitting as close to the line as Tijuana
 *    does — El Paso reads sparse for exactly that reason, the cheap
 *    direction of the trade.
 *  - The Atlantic, Gulf, and Pacific coastlines are traced loosely; losing
 *    a headland or a barrier island here and there is the accepted cost of
 *    a hand-drawn ring at continental scale.
 * Alaska and Hawaii are separate rings below — neither is reachable from a
 * CONUS-shaped polygon without a straight edge across land or sea that
 * belongs to neither.
 */
const CONUS: Ring = [
  [48.99, -124.8],
  [49.0, -95.15],
  [49.0, -84.5],
  [45.0, -83.5], // Great Lakes traced coarsely — a free seam now that
  // CANADA_MAINLAND overlaps from the north.
  [42.0, -82.7],
  [42.85, -79.05], // Niagara: placed to keep Buffalo back when Fort Erie
  // across the river was sparse ground; both banks are dense now.
  [44.0, -76.4],
  [45.0, -74.7],
  [45.0, -67.0],
  [40.5, -73.9],
  [32.0, -80.0],
  [25.2, -80.2],
  [25.8, -97.1],
  [26.0, -97.4],
  [29.7, -101.5],
  [31.85, -106.5], // Rio Grande diagonal's western end, near El Paso/Juárez.
  [31.3, -111.0],
  [32.55, -114.95], // Colorado river reach: Yuma in, San Luis Río Colorado out.
  [32.85, -115.8], // Imperial valley: El Centro in, Mexicali out; Calexico,
  // on the line itself, is lost to the sparse side — the cheap direction.
  [32.7, -116.5],
  // Pacific end of the Mexico border: nudged north of the round number to
  // clear Tijuana (32.51N) while keeping San Diego (32.72N) inside — the
  // two are only ~20 km apart, among the tightest margins this ring holds.
  [32.55, -117.1],
  [42.0, -124.4],
  [48.3, -124.7],
];

/**
 * A box, not a coastline — Alaska's own shape is too intricate for this
 * module's purposes. From the antimeridian side (lon -179.99, never
 * crossing it — see coverage.ts on why a ring may not straddle ±180) east
 * to 129.9W: past the 141W border and clean over the panhandle, which
 * stopped being unboxable the day British Columbia's side of the line
 * turned dense — Juneau reads dense now, and the strip of BC the box
 * encloses is a free overlap, not a mistake. The one real loss left is the
 * Aleutians west of the antimeridian (Attu included), unreachable without
 * crossing it.
 */
const ALASKA: Ring = [
  [51.5, -179.99],
  [71.5, -179.99],
  [71.5, -129.9],
  [51.5, -129.9],
];

/** A small box around the main islands; Honolulu sits well inside it. */
const HAWAII: Ring = [
  [18.8, -160.5],
  [18.8, -154.5],
  [22.5, -154.5],
  [22.5, -160.5],
];

/**
 * One ring for the mainland and Tasmania both, per the regions this module
 * is drawn against — unlike the US's three separate landmasses, Bass Strait
 * is only ~240 km of open water between two pieces of the same dense
 * region, so the ring crosses it rather than needing a second polygon: it
 * runs down to Tasmania's northwest corner, around the island, and back up
 * to the mainland coast a little further east, enclosing Bass Strait itself
 * as harmless sea along the way. Hobart tests inside, and so does every
 * mainland capital this module is graded against.
 *
 * The one sharp edge is the north: Cape York is in, Port Moresby is out,
 * and the cut runs through the Torres Strait at roughly 10.4S rather than
 * hugging either coast — which loses the Strait's own islands to the
 * sparse side, an accepted cost at that scale. New Zealand has its own
 * ring below.
 */
const AUSTRALIA: Ring = [
  [-10.4, 142.0],
  [-10.4, 143.6], // Torres Strait cut — Cape York in, Port Moresby out.
  [-11.5, 132.5],
  [-11.0, 130.0], // Pushed north of Darwin to keep the Top End inside.
  [-13.5, 126.0],
  [-17.5, 122.0],
  [-21.0, 114.0],
  [-26.0, 113.3],
  [-31.9, 115.0],
  [-35.1, 117.9],
  [-34.9, 124.0],
  [-31.5, 131.3],
  [-32.0, 133.9],
  [-35.2, 136.8],
  [-38.4, 140.9],
  [-39.1, 146.4], // Mainland attachment point west of the Tasmania crossing.
  [-40.5, 144.5], // Tasmania, northwest corner.
  [-43.7, 144.5],
  [-43.7, 148.5],
  [-40.5, 148.5], // Tasmania, northeast corner.
  [-37.5, 149.9], // Back to the mainland, east of the Tasmania crossing.
  [-33.9, 151.4],
  [-28.6, 153.7],
  [-24.5, 152.5],
  [-19.2, 146.9],
  [-14.5, 144.8],
];

/**
 * Continental Canada, drawn lazily on purpose — the luxury of joining a
 * list your neighbours are already on. The southern boundary runs straight
 * through the northern US and the western one into Alaska's box, free
 * overlaps both (the Nordics/Germany rule); the coasts spill to sea; and
 * the north stops at 74.5N, short of the high-Arctic archipelago —
 * Resolute and everything beyond read sparse, a sliver-class loss where
 * sparse is the honest answer anyway. Only two stretches face ground that
 * is not on the list: the east coast is kept well clear of Greenland
 * across Baffin Bay and the Davis Strait, and the Maritimes chain swings
 * outside Nova Scotia's Atlantic shore — while St-Pierre-et-Miquelon is
 * NEWFOUNDLAND's problem, below.
 */
const CANADA_MAINLAND: Ring = [
  [48.2, -125.8],
  [54.5, -134.5], // Sea west of Haida Gwaii; its far shore is the sliver lost.
  [59.9, -141.5],
  [69.8, -141.5], // The Alaska seam — ALASKA's box overlaps it, freely.
  [74.5, -120],
  [74.5, -93], // Arctic cap: Victoria Island in, Resolute and beyond out.
  [72.8, -77],
  [66.5, -60.5], // Baffin's SE coast — Davis Strait keeps Greenland far out.
  [60.3, -62.5],
  [54.5, -55.3],
  [51.9, -55.4], // Strait of Belle Isle; NEWFOUNDLAND takes over south of it.
  [47.2, -59.9], // Cabot Strait, splitting Cape Breton from Newfoundland.
  [45.7, -59.3],
  [43.2, -64.8], // Outside Nova Scotia's Atlantic shore — Halifax stays in.
  [44.5, -70], // Into Maine, and free ground from here west:
  [41.6, -83], // through Ohio — the dip southern Ontario needs —
  [47.0, -90],
  [47.5, -95],
  [47.5, -124.6], // and a flat run across Minnesota to Washington.
];

/**
 * The island of Newfoundland, and this module's one sharp edge in the
 * northwest Atlantic: St-Pierre-et-Miquelon is France, sits one boat-hop
 * off the Burin peninsula, and is on nobody's dense list — so the south
 * coast is traced with real vertices where everything else about this
 * ring is generous sea. Fortune and Grand Bank stay in; St-Pierre and
 * Miquelon, three tenths of a degree away, stay out. Labrador rides with
 * CANADA_MAINLAND.
 */
const NEWFOUNDLAND: Ring = [
  [47.5, -59.5],
  [50.0, -58.2],
  [51.8, -56.0], // North tip, spilling toward the Strait of Belle Isle.
  [49.8, -53.0],
  [47.6, -52.2], // Avalon's east, out to sea past St John's.
  [46.4, -53.0],
  [46.6, -54.3],
  [46.75, -55.1], // The Burin peninsula's tip — St Lawrence just inside.
  [47.02, -55.95], // Fortune and Grand Bank in…
  [47.35, -56.7], // …St-Pierre and Miquelon out. The one edge drawn tight.
  [47.55, -57.8],
];

/**
 * The whole island — the Republic and Northern Ireland both on §4.5.1's
 * list now, so one lazy box does what GREAT_BRITAIN's careful omission
 * used to apologise for. It spills into the Celtic and Irish seas and
 * toward the Scottish isles, all of it sea or dense ground; the Isle of
 * Man sits just east of it and stays sparse on the strict reading.
 */
const IRELAND: Ring = [
  [51.2, -10.8],
  [55.6, -10.8],
  [55.6, -5.3],
  [51.2, -5.3],
];

/**
 * Both main islands and Stewart Island in one box of open ocean. It stops
 * at 179E: the Chatham Islands live on the far side of the antimeridian,
 * which no ring here may straddle (see the module header) — a documented
 * sliver, not a gap. Norfolk Island, north of the box, stays sparse too.
 */
const NEW_ZEALAND: Ring = [
  [-47.6, 166.0],
  [-34.1, 166.0],
  [-34.1, 179.0],
  [-47.6, 179.0],
];

/** Checked in this order, though the order never matters: any match wins. */
const DENSE_REGIONS: readonly Ring[] = [
  NORDICS,
  GERMANY,
  GREAT_BRITAIN,
  IRELAND,
  CONUS,
  ALASKA,
  HAWAII,
  CANADA_MAINLAND,
  NEWFOUNDLAND,
  AUSTRALIA,
  NEW_ZEALAND,
];

/**
 * How confidently OSM's dog-park layer should be trusted near `position`
 * (docs/spec.md §4.5.1): `"dense"` inside at least one of the regions above,
 * `"sparse"` everywhere else — including every ocean, every pole, and the
 * many countries §4.5.1 simply doesn't mention. No exclude-holes and no
 * distance check: containment in a coarse hand-drawn ring is the entire
 * heuristic.
 */
export function mappingDensityAt(position: LatLon): MappingDensity {
  return DENSE_REGIONS.some((ring) => pointInRing(position, ring))
    ? "dense"
    : "sparse";
}
