import {
  idbPutAny,
  idbDelete,
  idbCleanupOldKeys,
  idbOpen,
  resetIdbOpen,
} from "./idb";

// ---------- Fake IDB ----------

/**
 * Minimal fake that simulates the IDB transaction lifecycle.
 * The real IDB fires oncomplete/onerror/onabort asynchronously after
 * the request is queued — queueMicrotask approximates this timing.
 */
function fakeDb(outcome: "complete" | "error" | "abort"): IDBDatabase {
  const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");

  return {
    transaction: () => {
      const tx: Record<string, unknown> = {
        objectStore: () => ({ put: () => ({}), delete: () => ({}) }),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: outcome !== "complete" ? quotaError : null,
      };

      queueMicrotask(() => {
        const handler = tx[
          outcome === "complete"
            ? "oncomplete"
            : outcome === "error"
              ? "onerror"
              : "onabort"
        ] as (() => void) | null;
        handler?.();
      });

      return tx;
    },
  } as unknown as IDBDatabase;
}

// ---------- Tests ----------

describe("idbPutAny", () => {
  it("resolves on success", async () => {
    await expect(
      idbPutAny(fakeDb("complete"), "k", { x: 1 }),
    ).resolves.toBeUndefined();
  });

  it("rejects on error", async () => {
    await expect(idbPutAny(fakeDb("error"), "k", { x: 1 })).rejects.toThrow();
  });
});

describe("idbDelete", () => {
  it("resolves on success", async () => {
    await expect(idbDelete(fakeDb("complete"), "k")).resolves.toBeUndefined();
  });

  it("rejects on error", async () => {
    await expect(idbDelete(fakeDb("error"), "k")).rejects.toThrow();
  });
});

// ---------- Cleanup tests ----------

/** Fake DB that stores keys in memory so we can test cleanup logic. */
function fakeDbWithKeys(keys: string[]): {
  db: IDBDatabase;
  deleted: string[];
} {
  const deleted: string[] = [];

  const db = {
    transaction: (_store: string, mode?: string) => {
      const tx: Record<string, unknown> = {
        objectStore: () => ({
          getAllKeys: () => {
            const req: Record<string, unknown> = {
              result: [...keys],
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
            return req;
          },
          delete: (key: string) => {
            deleted.push(key);
            return {};
          },
        }),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };

      // Auto-complete readwrite transactions after deletes are issued
      if (mode === "readwrite") {
        queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
      }

      return tx;
    },
  } as unknown as IDBDatabase;

  return { db, deleted };
}

describe("idbCleanupOldKeys", () => {
  it("deletes keys with old version prefixes", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "dog-parks-v0-59.329,18.069,3000", // old
      "bathing-spots-v1-59.329,18.069,3000", // never shipped
      "dog-parks-v1-59.329,18.069,3000", // current
      "dog-parks-v1-59.329,18.069,10000", // current
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(2);
    expect(deleted).toEqual([
      "dog-parks-v0-59.329,18.069,3000",
      "bathing-spots-v1-59.329,18.069,3000",
    ]);
  });

  it("returns 0 when all keys are current", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "dog-parks-v1-59.329,18.069,3000",
      "dog-parks-v1-57.708,11.974,25000",
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("returns 0 for an empty store", async () => {
    const { db } = fakeDbWithKeys([]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(0);
  });

  it("deletes all keys when none match current prefixes", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "dog-parks-v0-59.329,18.069,3000",
      "tile-v1-en-42",
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(2);
    expect(deleted).toEqual([
      "dog-parks-v0-59.329,18.069,3000",
      "tile-v1-en-42",
    ]);
  });
});

// ---------- idbOpen tests ----------

describe("idbOpen", () => {
  const origIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    resetIdbOpen();
  });

  afterEach(() => {
    globalThis.indexedDB = origIndexedDB;
  });

  /**
   * Helper: install a fake indexedDB.open that calls onerror for the first
   * `failCount` calls, then onsuccess for all subsequent calls.
   */
  function installFakeIndexedDB(fakeDB: IDBDatabase, failCount: number) {
    let callCount = 0;
    globalThis.indexedDB = {
      open: () => {
        callCount++;
        const req: Record<string, unknown> = {
          result: fakeDB,
          error: new DOMException("open failed"),
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };
        const current = callCount;
        queueMicrotask(() => {
          if (current <= failCount) {
            (req.onerror as (() => void) | null)?.();
          } else {
            (req.onsuccess as (() => void) | null)?.();
          }
        });
        return req;
      },
    } as unknown as typeof indexedDB;
    return { getCallCount: () => callCount };
  }

  it("retries after a transient failure instead of caching null", async () => {
    const fakeDB = {} as IDBDatabase;
    const { getCallCount } = installFakeIndexedDB(fakeDB, 1);

    const first = await idbOpen();
    expect(first).toBeNull();

    const second = await idbOpen();
    expect(second).toBe(fakeDB);
    expect(getCallCount()).toBe(2);
  });

  it("retries through multiple consecutive failures before succeeding", async () => {
    const fakeDB = {} as IDBDatabase;
    const { getCallCount } = installFakeIndexedDB(fakeDB, 3);

    expect(await idbOpen()).toBeNull();
    expect(await idbOpen()).toBeNull();
    expect(await idbOpen()).toBeNull();

    const result = await idbOpen();
    expect(result).toBe(fakeDB);
    expect(getCallCount()).toBe(4);
  });

  it("concurrent callers during failure both receive null", async () => {
    const fakeDB = {} as IDBDatabase;
    installFakeIndexedDB(fakeDB, 1);

    // Both calls issued before the microtask fires share the same promise
    const [a, b] = await Promise.all([idbOpen(), idbOpen()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("caches the promise after a successful open", async () => {
    const fakeDB = {} as IDBDatabase;
    const { getCallCount } = installFakeIndexedDB(fakeDB, 0);

    const first = await idbOpen();
    const second = await idbOpen();

    expect(first).toBe(fakeDB);
    expect(second).toBe(fakeDB);
    expect(getCallCount()).toBe(1);
  });

  it("returns null when indexedDB is undefined", async () => {
    delete (globalThis as any).indexedDB;

    const result = await idbOpen();
    expect(result).toBeNull();
  });
});
