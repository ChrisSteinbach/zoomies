import { idbGetAny, idbOpen, idbPutAny } from "./idb";
import type { PlaceProvider } from "./place-provider";
import type { DogSpot } from "./types";

/**
 * Caching answers so we ask Overpass once (docs/spec.md §5, fair use).
 *
 * Policy about *whether* to ask at all, layered on a {@link PlaceProvider}
 * that does exactly one query. It is a `PlaceProvider` itself, so it drops
 * anywhere in the stack — and because it stores only {@link DogSpot}s, the
 * phase-4 offline provider could sit under it unchanged.
 */

/**
 * The key prefixes, one per layer, each carrying the schema version of what
 * is stored under it.
 *
 * Separate prefixes because the two layers answer different questions about
 * the same cell: "no dog parks within 3 km of here" must never be served as
 * the answer to "where can my dog swim", nor the reverse.
 *
 * Bump a version whenever the {@link DogSpot}s stored under it or
 * {@link CacheEntry} change shape: entries written by an older version then
 * stop matching, and `idbCleanupOldKeys` sweeps them up. Keep both in step
 * with CURRENT_KEY_PREFIXES in idb.ts.
 */
export const PARKS_CACHE_KEY_PREFIX = "dog-parks-v1-";
export const BATHING_CACHE_KEY_PREFIX = "bathing-v1-";

/**
 * How coarsely a position is rounded before it becomes a cache key.
 *
 * Three decimals, so a cell is 0.001° — about 111 m of latitude, and about
 * 57 m of longitude at Stockholm's 59°N. Rounding into that grid moves the
 * remembered query centre by at most ~60 m from where the user actually is,
 * which is inside the jitter of a phone GPS fix and about 2 % of the
 * narrowest 3 km search radius: the only features it can add or drop sit
 * ~3 km away, nowhere near the nearest handful the UI shows.
 *
 * The neighbouring choices are both worse. Two decimals is a cell over a
 * kilometre across, which can move the centre by 600 m and genuinely change
 * which park is nearest. Four decimals is a cell of about 11 m, smaller than
 * the GPS jitter it exists to absorb, so standing still would still miss.
 */
export const CACHE_CELL_DECIMALS = 3;

/**
 * How long a cached answer stays good.
 *
 * A week. Dog parks change on the timescale of municipal construction, and
 * docs/spec.md §5 judges even monthly regeneration of the whole dataset
 * plenty — so a week bounds staleness more tightly than the offline data path
 * would have. A park that opened yesterday is missing for at most seven days;
 * in exchange, a user who opens the app daily in their own neighbourhood
 * queries the shared service once.
 */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The slice of storage the cache needs.
 *
 * Narrow on purpose: the decorator's own tests are about rounding, expiry and
 * degradation, and none of that should need an IndexedDB to exercise.
 */
export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface PlaceCacheOptions {
  /** Where to keep answers. Defaults to IndexedDB. */
  store?: CacheStore;
  /** How long an answer stays good. Defaults to {@link CACHE_TTL_MS}. */
  ttlMs?: number;
  /** The clock, injectable so expiry is testable without waiting a week. */
  now?: () => number;
}

/** What one cache slot holds. */
interface CacheEntry {
  /** When the answer was stored, epoch ms. */
  storedAt: number;
  spots: DogSpot[];
}

/** One lookup of one layer: the shape both provider methods share. */
type Lookup = PlaceProvider["findDogParks"];

/**
 * Wraps a provider so repeat lookups from the same place are free.
 *
 * A cache miss is never a failure: if storage is unavailable, unreadable or
 * full, this degrades to a plain pass-through. A broken cache must not break
 * the app.
 */
export function withCache(
  provider: PlaceProvider,
  options: PlaceCacheOptions = {},
): PlaceProvider {
  const store = options.store ?? createIdbCacheStore();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const remembered =
    (prefix: string, lookup: Lookup): Lookup =>
    async (lat, lon, radiusM) => {
      const key = cacheKey(prefix, lat, lon, radiusM);

      const cached = await readEntry(store, key, ttlMs, now());
      if (cached) return cached.spots;

      const spots = await lookup(lat, lon, radiusM);
      // Only successes are stored — a failure is a fact about the network at
      // one moment, not about the place. Zero results *are* stored: an empty
      // answer is legitimate (§3), and a sparsely mapped region is exactly
      // where re-asking the shared service buys nothing.
      await writeEntry(store, key, { storedAt: now(), spots });
      return spots;
    };

  return {
    // Called through rather than passed by reference: an unbound method loses
    // the provider it belongs to.
    findDogParks: remembered(PARKS_CACHE_KEY_PREFIX, (lat, lon, radiusM) =>
      provider.findDogParks(lat, lon, radiusM),
    ),
    findBathingSpots: remembered(
      BATHING_CACHE_KEY_PREFIX,
      (lat, lon, radiusM) => provider.findBathingSpots(lat, lon, radiusM),
    ),
  };
}

/**
 * A {@link CacheStore} on top of IndexedDB.
 *
 * Missing IndexedDB — private browsing, an old WebView, the Node test
 * environment — reads as an empty cache rather than an error.
 */
export function createIdbCacheStore(): CacheStore {
  return {
    async get(key) {
      const db = await idbOpen();
      if (!db) return undefined;
      return await idbGetAny<unknown>(db, key);
    },
    async set(key, value) {
      const db = await idbOpen();
      if (!db) return;
      await idbPutAny(db, key, value);
    },
  };
}

/**
 * The cell a lookup falls in.
 *
 * Radius is part of the key and is not rounded: the expanding search asks
 * about the same centre at 3, 10 and 25 km, and answering a 25 km question
 * with a 3 km answer would silently hide most of the map.
 */
function cacheKey(
  prefix: string,
  lat: number,
  lon: number,
  radiusM: number,
): string {
  return `${prefix}${cell(lat)},${cell(lon)},${Math.round(radiusM)}`;
}

function cell(degrees: number): string {
  const grid = 10 ** CACHE_CELL_DECIMALS;
  const snapped = Math.round(degrees * grid) / grid;
  // `-0` and `0` are the same place but `(-0).toFixed(3)` is "-0.000", which
  // would be a second key for one cell just west of Greenwich.
  return (snapped === 0 ? 0 : snapped).toFixed(CACHE_CELL_DECIMALS);
}

/** A usable entry for this key, or nothing. Never throws. */
async function readEntry(
  store: CacheStore,
  key: string,
  ttlMs: number,
  at: number,
): Promise<CacheEntry | undefined> {
  let stored: unknown;
  try {
    stored = await store.get(key);
  } catch {
    return undefined;
  }

  const entry = toCacheEntry(stored);
  if (!entry) return undefined;

  const age = at - entry.storedAt;
  // A negative age means the device clock moved backwards since the write.
  // Treating that entry as fresh could pin it for as long as the clock is
  // wrong, so it is a miss — one extra query is cheaper than indefinite
  // staleness.
  if (age < 0 || age >= ttlMs) return undefined;

  return entry;
}

/** Stores an entry, or shrugs. Never throws. */
async function writeEntry(
  store: CacheStore,
  key: string,
  entry: CacheEntry,
): Promise<void> {
  try {
    await store.set(key, entry);
  } catch {
    // Out of quota, or storage denied. The answer is already in hand; losing
    // the chance to reuse it is not worth failing the lookup over.
  }
}

/**
 * A stored value read back as an entry, or nothing if it is not one.
 *
 * Anything we cannot vouch for is a miss. A cache exists to save a query,
 * never to change the answer — a half-parsed spot would reach the map as a
 * confidently wrong pin, which is the one thing the spec forbids (§3).
 */
function toCacheEntry(stored: unknown): CacheEntry | undefined {
  if (!isRecord(stored)) return undefined;

  const { storedAt, spots } = stored;
  if (typeof storedAt !== "number" || !Number.isFinite(storedAt)) {
    return undefined;
  }
  if (!Array.isArray(spots)) return undefined;

  const candidates: unknown[] = spots;
  if (!candidates.every(isDogSpot)) return undefined;

  return { storedAt, spots: candidates };
}

/**
 * Whether a stored value is still a {@link DogSpot}.
 *
 * The check is deliberately about what the UI needs to render safely rather
 * than an exhaustive schema: when `DogSpot` grows a field, bump the version
 * in that layer's key prefix instead of teaching this function to guess.
 */
function isDogSpot(value: unknown): value is DogSpot {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id === "") return false;
  if (value.kind !== "dog_park" && value.kind !== "bathing_spot") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (typeof value.lat !== "number" || !Number.isFinite(value.lat))
    return false;
  if (typeof value.lon !== "number" || !Number.isFinite(value.lon))
    return false;
  if (!isRecord(value.tags)) return false;
  if (!isSeasonalRule(value.seasonal)) return false;
  return (
    value.provenance === "designated" ||
    value.provenance === "permitted" ||
    value.provenance === "name-match"
  );
}

/**
 * Whether a stored `seasonal` field is one the app can act on — absent very
 * much included, which is the common case and the only one a dog park ever
 * has.
 *
 * Checked rather than waved through because this field is a claim about
 * legality, not a decoration: a ban window with a garbled endpoint would let
 * the UI work out that today is fine at a beach where it is not
 * (docs/spec.md §4.5.3). A half-read rule is worth exactly one more query.
 */
function isSeasonalRule(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "unparsed") return true;
  if (value.kind !== "ban") return false;
  return isMonthDay(value.from) && isMonthDay(value.to);
}

/** A `{ month, day }` inside the calendar, whatever else it may hold. */
function isMonthDay(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { month, day } = value;
  if (typeof month !== "number" || !Number.isFinite(month)) return false;
  if (typeof day !== "number" || !Number.isFinite(day)) return false;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
