/**
 * Storage adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in storage-deno.ts.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
    get(key: string): string | null;
    put(key: string, value: string): void;
    delete(key: string): void;
    listKeys(prefix?: string): string[];
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _storage: StorageAdapter | null = null;

/**
 * Initialize the global storage adapter. Must be called once during `init()`.
 */
export function initStorage(adapter: StorageAdapter): void {
    _storage = adapter;
}

/**
 * Get the global storage adapter instance.
 * Throws if `initStorage()` has not been called.
 */
export function getStorage(): StorageAdapter {
    if (!_storage) {
        throw new Error(
            "StorageAdapter not initialized. Call initStorage() during language init().",
        );
    }
    return _storage;
}
