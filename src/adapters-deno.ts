/**
 * Deno-specific adapter implementations.
 * Wraps ad4m:host functions from @coasys/ad4m-ldk.
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import {
    httpFetch,
    storageGet,
    storagePut,
    storageDelete,
    storageListKeys,
    hash,
    emitSignal,
    emitPerspectiveDiff,
    agentSignStringHex,
    agentSigningKeyId,
} from "@coasys/ad4m-ldk";

import type { Transport, TransportResponse, StorageAdapter, RuntimeAdapter, SigningAdapter } from "./adapters.js";

// ---------------------------------------------------------------------------
// DenoTransport — HTTP transport using ad4m:host httpFetch
// ---------------------------------------------------------------------------

/**
 * httpFetch behavior (from executor's host.js):
 * - On 2xx success: returns the response body as a raw string
 * - On non-2xx: throws Error("http_fetch METHOD URL -> STATUS: BODY")
 */
export class DenoTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        try {
            const responseText = await httpFetch(
                url,
                method,
                JSON.stringify(headers),
                body,
            );

            return {
                status: 200,
                headers: {},
                body: responseText || "",
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const match = errMsg.match(/http_fetch\s+\S+\s+\S+\s+->\s+(\d+):\s*(.*)?$/s);
            if (match) {
                return {
                    status: parseInt(match[1], 10),
                    headers: {},
                    body: match[2] || "",
                };
            }
            console.error(`[transport] httpFetch error: ${errMsg}`);
            return { status: 0, headers: {}, body: errMsg };
        }
    }
}

// ---------------------------------------------------------------------------
// SidecarTransport — routes Kubo HTTP-API calls through the pubsub-bridge
// ---------------------------------------------------------------------------

/**
 * Rewrites the language's direct Kubo `/api/v0/*` calls to the sidecar so each
 * agent's ops land on ITS OWN Kubo node (routed by the `X-Ad4m-Did` header the
 * sidecar reads). Non-Kubo URLs (the sidecar's own `/publish` and `/messages`)
 * pass straight through to the underlying DenoTransport.
 *
 * This wrapper is what makes the identical-template constraint tractable: the
 * bundle keeps building `${IPFS_API_URL}/api/v0/...` URLs exactly as it would
 * against a bare node, and the transport transparently redirects each to
 * `${SIDECAR_URL}/kubo/...` with a JSON body the sidecar forwards to the right
 * node. `ipfs-api.ts` and most of `pubsub.ts` therefore need no change.
 *
 * Only the handful of ops the language actually issues are mapped:
 *   dag/put, dag/get, name/publish, name/resolve, pin/add, key/gen, key/list,
 *   pubsub/pub. `pubsub/peers` (telepresence online-detection only) is answered
 *   with an empty peer list — not load-bearing for convergence, and per-topic
 *   membership lives in the sidecar, not the sandbox.
 */
export class SidecarTransport implements Transport {
    private inner: DenoTransport;
    constructor(
        private sidecarUrl: string,
        private apiUrl: string,
        private did: string,
    ) {
        this.sidecarUrl = sidecarUrl.replace(/\/$/, "");
        this.inner = new DenoTransport();
    }

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        const apiPrefix = `${this.apiUrl}/api/v0/`;
        if (!url.startsWith(apiPrefix)) {
            // Sidecar-native endpoint (or anything else) — pass through, always
            // stamping the routing DID.
            return this.inner.fetch(url, method, { ...headers, "X-Ad4m-Did": this.did }, body);
        }

        const rest = url.slice(apiPrefix.length); // e.g. "dag/put?store-codec=..."
        const qIdx = rest.indexOf("?");
        const op = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
        const query = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : "");
        const H = { "X-Ad4m-Did": this.did, "Content-Type": "application/json" };
        const post = (path: string, obj: unknown) =>
            this.inner.fetch(`${this.sidecarUrl}${path}`, "POST", H, JSON.stringify(obj));

        switch (op) {
            case "dag/put": {
                // Body is multipart with a single JSON file part; extract it.
                const node = JSON.parse(extractMultipartFile(body));
                const pin = query.get("pin") !== "false";
                return post("/kubo/dag/put", { node, pin });
            }
            case "dag/get":
                return post("/kubo/dag/get", { cid: query.get("arg") });
            case "pin/add":
                return post("/kubo/pin/add", {
                    cid: query.get("arg"),
                    recursive: query.get("recursive") !== "false",
                });
            case "name/publish": {
                const ttl = query.get("ttl"); // "60s"
                const obj: Record<string, unknown> = { cid: query.get("arg") };
                if (query.get("key")) obj.key = query.get("key");
                if (ttl) obj.ttlSeconds = parseInt(ttl, 10);
                return post("/kubo/name/publish", obj);
            }
            case "name/resolve":
                return post("/kubo/name/resolve", { name: query.get("arg") });
            case "key/gen":
                return post("/kubo/key/gen", {
                    name: query.get("arg"),
                    type: query.get("type") || "ed25519",
                });
            case "key/list":
                return post("/kubo/key/list", {});
            case "pubsub/pub": {
                // The already-multibase-encoded topic is the `arg`; decode it
                // back to the raw topic the sidecar's /publish expects, and
                // lift the payload out of the multipart body.
                const encTopic = query.get("arg") || "";
                const topic = decodeMultibaseTopic(encTopic);
                const data = extractMultipartFile(body);
                return post("/publish", { topic, data });
            }
            case "pubsub/peers":
                // Not load-bearing for convergence; report no peers.
                return { status: 200, headers: {}, body: JSON.stringify({ Strings: [] }) };
            default:
                // Unknown op — forward verbatim to the real node (via DID route
                // is impossible here, so hit the configured apiUrl directly).
                return this.inner.fetch(url, method, headers, body);
        }
    }
}

/**
 * Extract the single file part's content from a Kubo-style multipart body.
 * The language builds these bodies itself (buildPubsubPublishBody / ipfsDagPut)
 * with one `name="file"` part, so a header/blank-line split is exact.
 */
function extractMultipartFile(body: string): string {
    const marker = "\r\n\r\n";
    const start = body.indexOf(marker);
    if (start < 0) return body;
    let payload = body.slice(start + marker.length);
    // Strip the trailing CRLF + closing boundary line.
    const lastBoundary = payload.lastIndexOf("\r\n--");
    if (lastBoundary >= 0) payload = payload.slice(0, lastBoundary);
    return payload;
}

/**
 * Decode a multibase base64url (`u`-prefixed, no-pad) topic back to its raw
 * string — the inverse of the language's encodeTopicMultibase.
 */
function decodeMultibaseTopic(encoded: string): string {
    if (!encoded || encoded[0] !== "u") return encoded;
    let b64 = encoded.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// DenoStorageAdapter
// ---------------------------------------------------------------------------

export class DenoStorageAdapter implements StorageAdapter {
    get(key: string): string | null {
        return storageGet(key);
    }

    put(key: string, value: string): void {
        storagePut(key, value);
    }

    delete(key: string): void {
        storageDelete(key);
    }

    listKeys(prefix?: string): string[] {
        return storageListKeys(prefix);
    }
}

// ---------------------------------------------------------------------------
// DenoRuntime
// ---------------------------------------------------------------------------

export class DenoRuntime implements RuntimeAdapter {
    hash(data: string): string {
        return hash(data);
    }

    emitSignal(data: string): void {
        emitSignal(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        emitPerspectiveDiff(diff);
    }
}

// ---------------------------------------------------------------------------
// DenoSigningAdapter
// ---------------------------------------------------------------------------

export class DenoSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return agentSignStringHex(payload);
    }

    signingKeyId(): string {
        return agentSigningKeyId();
    }
}
