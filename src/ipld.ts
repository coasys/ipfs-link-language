/**
 * IPLD DAG operations — DAG-JSON encoding for link triples.
 *
 * Uses getTransport() for IPFS HTTP API calls.
 * Uses injected adapters only — no ad4m:host imports.
 */

import { getTransport } from "./adapters.js";

// ---------------------------------------------------------------------------
// Pure functions (was ipld.pure.ts)
// ---------------------------------------------------------------------------
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


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagPutResult {
    cid: string;
}

export interface DagGetResult<T = unknown> {
    data: T;
}

// ---------------------------------------------------------------------------
// IPFS DAG API operations
// ---------------------------------------------------------------------------

/**
 * Store a DAG-JSON node on IPFS and return its CID.
 *
 * POST /api/v0/dag/put
 * Body: DAG-JSON encoded node
 * Query params: store-codec=dag-json, input-codec=dag-json, pin=<bool>
 */
export async function dagPut(
    apiUrl: string,
    data: unknown,
    pin: boolean = true,
): Promise<DagPutResult> {
    const encoded = dagJsonEncode(data);
    const url = `${apiUrl}/api/v0/dag/put?store-codec=dag-json&input-codec=dag-json&pin=${pin}`;

    const response = await getTransport().fetch(
        url,
        "POST",
        { "Content-Type": "application/json" },
        encoded,
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`dag/put failed: HTTP ${response.status} — ${response.body}`);
    }

    const result = JSON.parse(response.body);
    const cid = result.Cid?.["/"] || result.Cid || result.Hash || result.Key;
    if (!cid) {
        throw new Error(`dag/put returned no CID: ${response.body}`);
    }

    return { cid: typeof cid === "string" ? cid : String(cid) };
}

/**
 * Retrieve a DAG-JSON node from IPFS by CID.
 *
 * POST /api/v0/dag/get?arg={cid}&output-codec=dag-json
 */
export async function dagGet<T = unknown>(
    apiUrl: string,
    cid: string,
): Promise<DagGetResult<T>> {
    const url = `${apiUrl}/api/v0/dag/get?arg=${encodeURIComponent(cid)}&output-codec=dag-json`;

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`dag/get failed: HTTP ${response.status} — ${response.body}`);
    }

    const data = dagJsonDecode<T>(response.body);
    return { data };
}

