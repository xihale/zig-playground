/**
 * Persist Zig's WASI /cache (ZIR digests) across page reloads via IndexedDB.
 *
 * Storage: one packed blob (~35 MiB after first Hello-World-sized compile) plus
 * a small meta row keyed by zigVersion. Invalidates wholesale on version change.
 *
 * NOTE: Do not construct browser_wasi_shim File/Directory here — Vite can give
 * the worker two module instances, and Zig's FS layer uses `instanceof` checks.
 * Callers pass entries in/out as plain {path, data}; hydrate with their File class.
 */

/** Must match the Zig/std the playground ships; bump when upgrading. */
export const ZIR_CACHE_ZIG_VERSION = "0.15.2";

const DB_NAME = "zig-playground-zir-v1";
const DB_VERSION = 1;
const STORE = "kv";

export type FlatEntry = { path: string; data: Uint8Array };

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("indexedDB unavailable"));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "key" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("idb open failed"));
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("idb tx error"));
        tx.onabort = () => reject(tx.error ?? new Error("idb tx abort"));
    });
}

/** Binary pack: [u32 pathLen][path utf8][u32 dataLen][data]… */
export function packCache(entries: FlatEntry[]): ArrayBuffer {
    const enc = new TextEncoder();
    let total = 0;
    const parts: { pb: Uint8Array; data: Uint8Array }[] = [];
    for (const e of entries) {
        const pb = enc.encode(e.path);
        total += 4 + pb.length + 4 + e.data.byteLength;
        parts.push({ pb, data: e.data });
    }
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let o = 0;
    for (const { pb, data } of parts) {
        view.setUint32(o, pb.length, true);
        o += 4;
        out.set(pb, o);
        o += pb.length;
        view.setUint32(o, data.byteLength, true);
        o += 4;
        out.set(data, o);
        o += data.byteLength;
    }
    return out.buffer;
}

export function unpackCache(buf: ArrayBuffer): FlatEntry[] {
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const dec = new TextDecoder();
    const entries: FlatEntry[] = [];
    let o = 0;
    while (o + 8 <= u8.length) {
        const pl = view.getUint32(o, true);
        o += 4;
        if (o + pl + 4 > u8.length) break;
        const path = dec.decode(u8.subarray(o, o + pl));
        o += pl;
        const dl = view.getUint32(o, true);
        o += 4;
        if (o + dl > u8.length) break;
        entries.push({ path, data: u8.slice(o, o + dl) });
        o += dl;
    }
    return entries;
}

export type LoadZirResult = {
    bytes: number;
    files: number;
    entries: FlatEntry[];
};

/**
 * Load packed ZIR blob if meta.zigVersion matches.
 * Returns plain entries for the caller to hydrate with its File/Directory classes.
 */
export async function loadZirCacheEntries(
    zigVersion: string = ZIR_CACHE_ZIG_VERSION,
): Promise<LoadZirResult | null> {
    try {
        const db = await openDb();
        try {
            const tx = db.transaction(STORE, "readonly");
            const store = tx.objectStore(STORE);
            // Issue both gets BEFORE any await — IDB txs autoclose across awaits.
            const metaP = idbReq<{ key: string; zigVersion: string; bytes: number; files: number }>(
                store.get("meta"),
            );
            const blobP = idbReq<{ key: string; data: ArrayBuffer }>(store.get("blob"));
            const done = txDone(tx);
            const [meta, blob] = await Promise.all([metaP, blobP]);
            await done;

            if (!meta || meta.zigVersion !== zigVersion || !blob?.data) {
                return null;
            }

            const entries = unpackCache(blob.data);
            if (entries.length === 0) return null;
            return {
                bytes: meta.bytes ?? blob.data.byteLength,
                files: meta.files ?? entries.length,
                entries,
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/** Persist flat entries as a single blob. */
export async function saveZirCacheEntries(
    entries: FlatEntry[],
    zigVersion: string = ZIR_CACHE_ZIG_VERSION,
): Promise<LoadZirResult | null> {
    try {
        if (entries.length === 0) return null;

        const packed = packCache(entries);
        const db = await openDb();
        try {
            const tx = db.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            store.put({
                key: "blob",
                data: packed,
            });
            store.put({
                key: "meta",
                zigVersion,
                files: entries.length,
                bytes: packed.byteLength,
                savedAt: Date.now(),
            });
            await txDone(tx);
            return {
                bytes: packed.byteLength,
                files: entries.length,
                entries,
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

function idbReq<T>(req: IDBRequest): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
    });
}
