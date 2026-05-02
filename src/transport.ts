/**
 * Transport abstraction layer — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in transport-deno.ts.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface Transport {
    fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// WasmTransport — future WASM runtime via http-ext.fetch
// ---------------------------------------------------------------------------

export class WasmTransport implements Transport {
    async fetch(
        _url: string,
        _method: string,
        _headers: Record<string, string>,
        _body: string,
    ): Promise<TransportResponse> {
        throw new Error(
            "WasmTransport: http-ext is not available in the current runtime. " +
            "The executor must provide the http-ext WIT import for WASM Languages " +
            "to make outbound HTTP requests.",
        );
    }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _transport: Transport | null = null;

/**
 * Initialize the global transport. Must be called once during `init()`.
 */
export function initTransport(transport: Transport): void {
    _transport = transport;
}

/**
 * Get the global transport instance.
 * Throws if `initTransport()` has not been called.
 */
export function getTransport(): Transport {
    if (!_transport) {
        throw new Error(
            "Transport not initialized. Call initTransport() during language init().",
        );
    }
    return _transport;
}
