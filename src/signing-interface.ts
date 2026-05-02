/**
 * Signing adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in signing-deno.ts.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SigningAdapter {
    /** Sign a string payload and return the hex-encoded signature. */
    signStringHex(payload: string): string;
    /** Return the signing key ID. */
    signingKeyId(): string;
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _signing: SigningAdapter | null = null;

/**
 * Initialize the global signing adapter. Must be called once during `init()`.
 */
export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

/**
 * Get the global signing adapter instance.
 * Throws if `initSigning()` has not been called.
 */
export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
