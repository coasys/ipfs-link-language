/**
 * Pure DAG-JSON serialization/deserialization — zero runtime deps.
 *
 * DAG-JSON is the JSON-based IPLD codec. It represents IPLD links
 * as `{ "/": "<cid-string>" }` objects and bytes as
 * `{ "/": { "bytes": "<base64>" } }`.
 *
 * We use DAG-JSON instead of DAG-CBOR for pure JS / WASM compatibility
 * without requiring a CBOR library.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A DAG-JSON link reference */
export interface DagJsonLink {
    "/": string;
}

/** Check if a value is a DAG-JSON link */
export function isDagJsonLink(value: unknown): value is DagJsonLink {
    return (
        typeof value === "object" &&
        value !== null &&
        "/" in value &&
        typeof (value as DagJsonLink)["/"] === "string" &&
        Object.keys(value).length === 1
    );
}

/**
 * Create a DAG-JSON link to a CID.
 */
export function dagLink(cid: string): DagJsonLink {
    return { "/": cid };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Encode a value as DAG-JSON string.
 *
 * DAG-JSON is deterministic JSON with sorted keys.
 * This ensures the same data always produces the same string,
 * which is critical for content addressing.
 */
export function dagJsonEncode(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        if (val && typeof val === "object" && !Array.isArray(val)) {
            // Sort object keys for deterministic output
            const sorted: Record<string, unknown> = {};
            for (const k of Object.keys(val).sort()) {
                sorted[k] = val[k];
            }
            return sorted;
        }
        return val;
    });
}

/**
 * Decode a DAG-JSON string back to a value.
 */
export function dagJsonDecode<T = unknown>(json: string): T {
    return JSON.parse(json) as T;
}

// ---------------------------------------------------------------------------
// Deterministic hashing helpers
// ---------------------------------------------------------------------------

/**
 * Compute a simple SHA-256-like hash for DAG-JSON content.
 * This is a pure JS implementation for testing — at runtime,
 * the actual CID is computed by the IPFS node via dag/put.
 *
 * Uses the djb2 hash algorithm as a deterministic placeholder.
 * The real IPFS CID is computed by the IPFS HTTP API.
 */
export function dagJsonContentKey(data: unknown): string {
    const json = dagJsonEncode(data);
    let h = 5381;
    for (let i = 0; i < json.length; i++) {
        h = ((h << 5) + h + json.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).padStart(8, "0");
}
