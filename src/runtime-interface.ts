/**
 * Runtime interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in runtime-deno.ts.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
    /** Content-address hash: SHA-256 → base58btc, prefixed "Qm". */
    hash(data: string): string;
    /** Emit a signal to the executor. */
    emitSignal(data: string): void;
    /** Emit a perspective diff for local subscribers. */
    emitPerspectiveDiff(diff: unknown): void;
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _runtime: RuntimeAdapter | null = null;

/**
 * Initialize the global runtime adapter. Must be called once during `init()`.
 */
export function initRuntime(adapter: RuntimeAdapter): void {
    _runtime = adapter;
}

/**
 * Get the global runtime adapter instance.
 * Throws if `initRuntime()` has not been called.
 */
export function getRuntime(): RuntimeAdapter {
    if (!_runtime) {
        throw new Error(
            "RuntimeAdapter not initialized. Call initRuntime() during language init().",
        );
    }
    return _runtime;
}
