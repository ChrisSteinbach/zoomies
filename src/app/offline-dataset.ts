import { circleWithinCoverage } from "./coverage";
import type { CoverageArea, Ring } from "./coverage";
import { haversineMeters } from "./geo";
import type { PlaceProvider } from "./place-provider";
import type {
  DogSpot,
  DogSpotKind,
  MonthDay,
  Provenance,
  SeasonalRule,
  SpotTags,
} from "./types";

/**
 * The offline data path (docs/spec.md §5, Option B): a weekly pipeline cuts
 * every dog spot in a region out of a Geofabrik extract and publishes one
 * static JSON file; this module fetches that file once, keeps a copy in
 * IndexedDB, and answers queries from it with a plain linear scan.
 *
 * This is the PlaceProvider seam's payoff. The interface was built so the
 * data source could be replaced without the UI noticing (place-provider.ts),
 * and this is the replacement arriving: a decorator that answers from the
 * dataset when the dataset can honestly answer, and hands everything else to
 * the live stack unchanged. The stakes are measured, not guessed — the live
 * path's worst observed tail on a real phone was 43.9 s of Overpass, and the
 * scan here costs a millisecond or two over ~30k objects. A linear pass, per
 * CLAUDE.md: at this size a spatial index is pure overhead.
 *
 * Coverage decides per call, not per install. A 3 km search near Malmö lies
 * wholly inside the Sweden extract and is answered offline; the 25 km
 * widening of the same search reaches Denmark, where the extract would
 * silently answer short, so that radius goes to live Overpass instead
 * (coverage.ts). The expanding search therefore mixes sources across its
 * radii, and each answer is honest for its radius — the only invariant that
 * matters (spec §3).
 *
 * Failures here are nulls, not typed errors, and that is as deliberate as
 * the live provider's PlaceProviderError is. The live provider's caller has
 * nothing better to do than diagnose; this loader's caller always has a
 * better move — ask the live stack — so a fetch rejection, a timeout, a 404,
 * a garbled body and a future schema all collapse into the one fact that
 * matters: no offline answer right now.
 */

/**
 * The dataset format this build can read. A file written under any other
 * number reads as no file at all: guessing at a future format would put pins
 * on the map that nothing in this code vouches for.
 */
export const DATASET_SCHEMA_VERSION = 1;

/**
 * What the pipeline publishes: an envelope of provenance around the spots.
 */
export interface Dataset {
  schema: typeof DATASET_SCHEMA_VERSION;
  /** When the pipeline ran, ISO 8601. Informational — freshness policy is
   *  the loader's stale-while-revalidate, not an expiry stamped here. */
  generatedAt: string;
  /** Which extract the file was cut from, e.g. `"europe/sweden"`. */
  region: string;
  /** `"© OpenStreetMap contributors"` — carried in-band so the file states
   *  its own ODbL obligations wherever it travels. */
  attribution: string;
  /** `"ODbL-1.0"`, for the same reason. */
  license: string;
  /** The ground the file can answer for. Rings are [lat, lon] pairs —
   *  latitude first, the app's order, not GeoJSON's (see coverage.ts). */
  coverage: CoverageArea;
  /**
   * Both layers in one list; `kind` tells them apart. An element that is
   * both a dog park and a named hundbad appears twice, once per kind, same
   * id — mirroring how the two live queries would each return it.
   */
  spots: DogSpot[];
}

/**
 * Where the daily pipeline publishes the dataset: the repo's `dataset`
 * branch, served raw. raw.githubusercontent.com answers with
 * `Access-Control-Allow-Origin: *`, so the app can fetch it cross-origin,
 * and its CDN caches for ~5 minutes — nothing next to the file's daily
 * cadence. The file is the whole planet's dog spots (~1 MB gzipped), cut
 * from a seeded OSM state that the pipeline keeps current by replaying the
 * planet's daily replication diffs. Until the first pipeline run the branch
 * does not exist and this URL answers 404: the designed first-rollout
 * state, which reads as "no dataset" and leaves every query on the live
 * path.
 */
export const DEFAULT_DATASET_URL =
  "https://raw.githubusercontent.com/ChrisSteinbach/zoomies/dataset/dogspots.json";

/**
 * How long the dataset fetch may run before we abort it.
 *
 * The point of this path is beating a 43.9 s Overpass tail; a first open
 * that hangs on the dataset instead has traded one stall for another. Ten
 * seconds is generous for a file of this size off a CDN, and short enough
 * that giving up and answering live still feels like an answer.
 */
export const DATASET_FETCH_TIMEOUT_MS = 10_000;

/**
 * Loads the dataset, or says there is none to be had right now.
 *
 * Never rejects: null covers every way of not having a dataset, because the
 * caller's response to all of them is the same — use the live path. A null
 * is also never remembered, so the next call is free to try the network
 * again and a user's retry can succeed where the first open failed.
 */
export type DatasetLoader = () => Promise<Dataset | null>;

/**
 * The slice of storage the loader needs. Narrow on purpose, for the same
 * reason as place-cache's CacheStore: the loader's tests are about
 * resolution order, refresh and degradation, and none of that should need
 * an IndexedDB to exercise.
 */
export interface DatasetStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface DatasetLoaderOptions {
  /** Where the dataset lives. Defaults to {@link DEFAULT_DATASET_URL}. */
  url?: string;
  /** The `fetch` to use — injected so tests can drive every response shape
   *  without a network, exactly as in overpass.ts. */
  fetchImpl?: typeof fetch;
  /** Where the copy is kept between sessions. Defaults to IndexedDB. */
  store?: DatasetStore;
}

/**
 * One loader is one session's view of the dataset.
 *
 * Resolution order per call: the in-memory copy, then IndexedDB, then the
 * network. Concurrent calls share one in-flight load. A stored copy is
 * returned immediately and kicks off at most one background refresh per
 * session — stale-while-revalidate, because for data regenerated weekly,
 * first paint beats freshness by any measure a user can feel: the copy is at
 * most a week behind, and dog parks change on the timescale of municipal
 * construction. The refresh validates before it writes, so a broken or
 * future-schema download can never clobber a good stored copy.
 */
export function createDatasetLoader(
  options: DatasetLoaderOptions = {},
): DatasetLoader {
  const url = options.url ?? DEFAULT_DATASET_URL;
  // Wrapped rather than aliased: an unbound `globalThis.fetch` throws
  // "Illegal invocation" when called in a browser.
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const store = options.store ?? createIdbDatasetStore();
  // The url is part of the key, so a loader pointed somewhere new can never
  // be answered with another file's stored copy.
  const key = `${DATASET_KEY_PREFIX}${url}`;

  let inMemory: Dataset | null = null;
  let inFlight: Promise<Dataset | null> | null = null;
  let refreshed = false;

  /** Fetches and validates; a good file updates memory and the store. */
  const fromNetwork = async (): Promise<Dataset | null> => {
    const fetched = await fetchDataset(fetchImpl, url);
    if (!fetched) return null;
    inMemory = fetched;
    await writeDataset(store, key, fetched);
    return fetched;
  };

  /** The one background refresh a session gets, behind a stored copy. */
  const refreshOnce = (): void => {
    if (refreshed) return;
    refreshed = true;
    // Un-awaited on purpose — the stored copy is already answering — but
    // never unhandled: fromNetwork resolves null on every failure, and this
    // catch keeps that true if it ever learns to throw.
    fromNetwork().catch(() => undefined);
  };

  const loadOnce = async (): Promise<Dataset | null> => {
    const stored = await readDataset(store, key);
    if (stored) {
      inMemory = stored;
      refreshOnce();
      return stored;
    }
    return fromNetwork();
  };

  return () => {
    if (inMemory) return Promise.resolve(inMemory);
    if (!inFlight) {
      // Only a success is remembered. A load that ends null clears the slot,
      // so the next call — a retry button, a regained connection — reaches
      // the network again instead of replaying the failure.
      inFlight = loadOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/** One lookup of one layer: the shape both provider methods share. */
type Lookup = PlaceProvider["findDogParks"];

/**
 * A {@link PlaceProvider} that answers offline when it honestly can, and
 * delegates to the live stack when it cannot.
 *
 * "Honestly" is {@link circleWithinCoverage}'s judgement, made per call:
 * a 3 km circle near Malmö fits inside the Sweden dataset, while the 25 km
 * widening of the same search crosses to Denmark and must go live. The
 * expanding search naturally mixes sources across its radii, and each
 * answer is honest for its radius.
 *
 * The offline branch itself never fails: by the time it is taken, the data
 * is in hand and the rest is arithmetic. A loader null and an uncovered
 * circle both mean delegation, with the live provider's errors propagating
 * untouched — they are already the domain errors the UI handles. Nothing is
 * sorted (the PlaceProvider contract leaves that to callers) and nothing is
 * cached on the offline path: the scan costs a millisecond or two, less
 * than the storage read a cache would spend saving it. Callers get the
 * dataset's own DogSpot objects, not copies — nobody mutates results.
 */
export function withOfflineDataset(
  load: DatasetLoader,
  live: PlaceProvider,
): PlaceProvider {
  const answered =
    (kind: DogSpotKind, viaLive: Lookup): Lookup =>
    async (lat, lon, radiusM) => {
      const data = await load();
      if (
        !data ||
        !circleWithinCoverage({ lat, lon }, radiusM, data.coverage)
      ) {
        return viaLive(lat, lon, radiusM);
      }
      // The linear scan CLAUDE.md prescribes: a few thousand objects, one
      // haversine each.
      return data.spots.filter(
        (spot) =>
          spot.kind === kind && haversineMeters({ lat, lon }, spot) <= radiusM,
      );
    };

  return {
    // Called through rather than passed by reference: an unbound method
    // loses the provider it belongs to.
    findDogParks: answered("dog_park", (lat, lon, radiusM) =>
      live.findDogParks(lat, lon, radiusM),
    ),
    findBathingSpots: answered("bathing_spot", (lat, lon, radiusM) =>
      live.findBathingSpots(lat, lon, radiusM),
    ),
  };
}

// ---------- The network copy ----------

/**
 * The file over the network, or null.
 *
 * A GET of a public static file, aborted after
 * {@link DATASET_FETCH_TIMEOUT_MS} in the same shape as overpass.ts's
 * postQuery — without a deadline of our own, a stalled connection pins the
 * loader for the browser's default of minutes. Every way this can go wrong —
 * rejection, timeout, non-2xx (including the designed 404 before the first
 * pipeline run), a body that is not JSON, a body that is not a dataset — is
 * the same null, because the caller's next move is the same live fallback.
 */
async function fetchDataset(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Dataset | null> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    DATASET_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const parsed: unknown = JSON.parse(await response.text());
    return toDataset(parsed);
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

// ---------- The stored copy ----------

/**
 * The stored copy, if there is one and it still reads as a dataset. Never
 * throws: private browsing, a locked profile or a torn write all read as
 * "no copy", and the loader moves on to the network.
 */
async function readDataset(
  store: DatasetStore,
  key: string,
): Promise<Dataset | null> {
  try {
    return toDataset(await store.get(key));
  } catch {
    return null;
  }
}

/**
 * Stores the copy, or shrugs. Out of quota or storage denied: the copy in
 * memory still answers this session, and the next session refetches — losing
 * the head start is not worth failing a load that has already succeeded.
 */
async function writeDataset(
  store: DatasetStore,
  key: string,
  dataset: Dataset,
): Promise<void> {
  try {
    await store.set(key, dataset);
  } catch {
    // Deliberately silent; see above.
  }
}

// ---------- Validation ----------
//
// The file is an external boundary. It is our own pipeline's artifact, but
// it arrives over a network and comes back out of IndexedDB, and either trip
// can deliver it in halves — so both are validated with the same hand-rolled
// guards, in the house style of overpass.ts. The envelope must be right or
// the whole file is refused; a single bad spot is dropped alone. Fewer
// results beat wrong ones (spec §3).

/** The value as a dataset, or null if it is not one this build can serve. */
function toDataset(value: unknown): Dataset | null {
  if (!isRecord(value)) return null;

  const { schema, generatedAt, region, attribution, license } = value;
  if (schema !== DATASET_SCHEMA_VERSION) return null;
  // The metadata strings are required: the pipeline always writes them, so a
  // file missing its region or its attribution line is not our file.
  if (typeof generatedAt !== "string") return null;
  if (typeof region !== "string") return null;
  if (typeof attribution !== "string") return null;
  if (typeof license !== "string") return null;

  const coverage = toCoverage(value.coverage);
  if (!coverage) return null;

  if (!Array.isArray(value.spots)) return null;
  const candidates: unknown[] = value.spots;
  const spots: DogSpot[] = [];
  for (const candidate of candidates) {
    const spot = toSpot(candidate);
    if (spot) spots.push(spot);
  }

  return {
    schema: DATASET_SCHEMA_VERSION,
    generatedAt,
    region,
    attribution,
    license,
    coverage,
    spots,
  };
}

/**
 * The coverage polygon, or null when it cannot be trusted whole.
 *
 * Coverage is load-bearing geometry — it is what stops the dataset answering
 * for Copenhagen — so unlike a spot, one bad ring refuses the entire file:
 * a polygon with a corrupt ring might cover ground the extract does not.
 * An empty include list would cover nothing and turn every query into a
 * live one silently; refusing it makes the file's brokenness a fact the
 * pipeline can notice rather than a mystery slowdown.
 */
function toCoverage(value: unknown): CoverageArea | null {
  if (!isRecord(value)) return null;
  const include = toRings(value.include);
  const exclude = toRings(value.exclude);
  if (!include || !exclude || include.length === 0) return null;
  return { include, exclude };
}

function toRings(value: unknown): Ring[] | null {
  if (!Array.isArray(value)) return null;
  const candidates: unknown[] = value;
  const rings: Ring[] = [];
  for (const candidate of candidates) {
    if (!isRing(candidate)) return null;
    rings.push(candidate);
  }
  return rings;
}

/** [lat, lon] pairs of finite numbers — the shape coverage.ts rings have. */
function isRing(value: unknown): value is Ring {
  if (!Array.isArray(value)) return false;
  const points: unknown[] = value;
  return points.every(isLatLonPair);
}

function isLatLonPair(value: unknown): value is readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const pair: unknown[] = value;
  return isFiniteNumber(pair[0]) && isFiniteNumber(pair[1]);
}

/**
 * A stored value as a spot, or null.
 *
 * The invariant fields — identity, kind, position, provenance — must hold or
 * the spot is dropped: a pin that cannot be placed, or whose claim about
 * dogs cannot be read, is worse than one result fewer (spec §3). The
 * optional fields fail softer. A name that is not a non-empty string is
 * omitted, which the UI already handles for genuinely unnamed parks; a
 * seasonal rule that does not read as one is dropped from the spot rather
 * than taking the spot with it, and safely so — the UI shows its
 * verify-signage caveat on every bathing spot regardless (types.ts), so a
 * dropped rule degrades to the generic warning instead of inventing a
 * specific one.
 */
function toSpot(value: unknown): DogSpot | null {
  if (!isRecord(value)) return null;

  const { id, kind, name, lat, lon, tags, provenance, seasonal } = value;
  if (typeof id !== "string" || id === "") return null;
  if (!isDogSpotKind(kind)) return null;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  if (!isRecord(tags)) return null;
  if (!isProvenance(provenance)) return null;

  const spot: DogSpot = {
    id,
    kind,
    lat,
    lon,
    tags: toStoredTags(tags),
    provenance,
  };
  if (typeof name === "string" && name !== "") spot.name = name;
  const rule = toSeasonalRule(seasonal);
  if (rule) spot.seasonal = rule;
  return spot;
}

/**
 * The tags a stored spot can still vouch for.
 *
 * Read field by field rather than trusted as a block: in SpotTags, absence
 * means "OSM does not say" (types.ts), so a fenced flag that is no longer a
 * boolean must become absence, never a guess.
 */
function toStoredTags(value: Record<string, unknown>): SpotTags {
  const tags: SpotTags = {};
  if (typeof value.fenced === "boolean") tags.fenced = value.fenced;
  if (typeof value.lit === "boolean") tags.lit = value.lit;
  if (typeof value.surface === "string") tags.surface = value.surface;
  return tags;
}

/**
 * A stored seasonal field as a rule, or null to drop the field.
 *
 * Checked to the calendar, not just to shape, for place-cache.ts's reason:
 * this field is a claim about legality, and a ban window with a garbled
 * endpoint would let the UI work out that today is fine at a beach where it
 * is not (docs/spec.md §4.5.3).
 */
function toSeasonalRule(value: unknown): SeasonalRule | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unparsed") return { kind: "unparsed" };
  if (value.kind !== "ban") return null;
  const from = toMonthDay(value.from);
  const to = toMonthDay(value.to);
  if (!from || !to) return null;
  return { kind: "ban", from, to };
}

function toMonthDay(value: unknown): MonthDay | null {
  if (!isRecord(value)) return null;
  const { month, day } = value;
  if (!isFiniteNumber(month) || !isFiniteNumber(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function isDogSpotKind(value: unknown): value is DogSpotKind {
  return value === "dog_park" || value === "bathing_spot";
}

function isProvenance(value: unknown): value is Provenance {
  return (
    value === "designated" || value === "permitted" || value === "name-match"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- IndexedDB plumbing ----------
//
// A small database of the dataset's own rather than a key in place-cache's
// store, because the two have different lifecycles: the query cache is many
// small entries swept by prefix on startup (idbCleanupOldKeys), and a
// dataset key in that store would either be swept as an orphan or force
// idb.ts — deliberately domain-free — to learn about datasets. A second
// database also needs no version bump or upgrade handler on the first. The
// plumbing below is idb.ts's style at a single-key store's length.

const DATASET_IDB_NAME = "zoomies-dataset";
const DATASET_IDB_STORE = "dataset";
const DATASET_KEY_PREFIX = `dataset-v${DATASET_SCHEMA_VERSION}-`;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatasetDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DATASET_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DATASET_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("Dataset IDB open failed:", req.error);
      // Cleared rather than cached, as in idb.ts: a failure here is often
      // transient, and caching the null would disable the store for the
      // rest of the session.
      dbPromise = null;
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * A {@link DatasetStore} on top of IndexedDB. Missing IndexedDB — private
 * browsing, an old WebView, the Node test environment — reads as an empty
 * store rather than an error, and the loader answers from the network.
 */
function createIdbDatasetStore(): DatasetStore {
  return {
    async get(key) {
      const db = await openDatasetDb();
      if (!db) return undefined;
      return await new Promise<unknown>((resolve, reject) => {
        const req = db
          .transaction(DATASET_IDB_STORE, "readonly")
          .objectStore(DATASET_IDB_STORE)
          .get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () =>
          reject(req.error ?? new DOMException("Request failed"));
      });
    },
    async set(key, value) {
      const db = await openDatasetDb();
      if (!db) return;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DATASET_IDB_STORE, "readwrite");
        tx.objectStore(DATASET_IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error ?? new DOMException("Transaction failed"));
        tx.onabort = () =>
          reject(tx.error ?? new DOMException("Transaction aborted"));
      });
    },
  };
}
