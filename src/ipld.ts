/**
 * IPLD DAG operations — DAG-JSON encoding for link triples.
 *
 * Uses getTransport() for IPFS HTTP API calls.
 * Uses injected adapters only — no ad4m:host imports.
 */

import { getTransport } from "./transport.js";
import { dagJsonEncode, dagJsonDecode } from "./ipld.pure.js";
import type { DagJsonLink } from "./ipld.pure.js";

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

// Re-export pure functions for convenience
export { dagJsonEncode, dagJsonDecode, dagLink, isDagJsonLink } from "./ipld.pure.js";
export type { DagJsonLink } from "./ipld.pure.js";
