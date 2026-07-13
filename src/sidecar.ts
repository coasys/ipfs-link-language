/**
 * Sidecar transport — the language's client for the Node.js pubsub-bridge.
 *
 * The IPFS link language runs inside the executor's Deno sandbox, whose
 * httpFetch buffers and UTF-8-decodes the entire response body. That makes it
 * impossible to hold a long-lived `pubsub/sub` receive stream from inside the
 * sandbox: the language can PUBLISH to a topic but never RECEIVE off one. The
 * pubsub-bridge sidecar (gateway/) owns that streaming and exposes a pollable
 * `GET /messages`. This module is the thin in-sandbox client for it.
 *
 * It also carries the inline-diff transport that lets convergence ride pubsub
 * instead of bitswap: on Kubo 0.42.0 two directly-peered nodes never negotiate
 * `/ipfs/bitswap`, so a peer's commit BLOCK cannot be fetched cross-node. So
 * each new commit's FULL body is published inline over a per-neighbourhood diff
 * topic; peers ingest those bodies into a local commit cache that
 * `fetchCommit` consults before ever attempting a cross-node `dag/get`. Blocks
 * are still written to the local blockstore so the LOCAL revision (head CID) is
 * a real content address.
 *
 * All calls carry the agent DID (`X-Ad4m-Did`) so the sidecar routes each agent
 * to its own Kubo node — genuinely separate nodes behind one templated bundle.
 *
 * No ad4m:host imports — uses the injected transport + storage adapters.
 */

import { getTransport, getStorage } from "./adapters.js";
import type { PerspectiveCommitNode } from "./perspective-dag.js";
import type { DID } from "./types.js";

// ---------------------------------------------------------------------------
// Module config (set once during init when SIDECAR_URL is templated)
// ---------------------------------------------------------------------------

let _sidecarUrl: string | null = null;
let _did: DID = "";

/**
 * Enable sidecar mode. When set, Kubo calls route through the sidecar and
 * convergence rides inline pubsub diffs. When never called, the language runs
 * in direct-Kubo mode (unit tests, single-node) with no behavioural change.
 */
export function initSidecar(sidecarUrl: string, did: DID): void {
    _sidecarUrl = sidecarUrl.replace(/\/$/, "");
    _did = did;
}

/** True if sidecar mode is active. */
export function sidecarEnabled(): boolean {
    return _sidecarUrl !== null;
}

/** The configured sidecar base URL (throws if not enabled). */
export function sidecarUrl(): string {
    if (_sidecarUrl === null) throw new Error("sidecar not initialised");
    return _sidecarUrl;
}

/** Standard headers for every sidecar request (carries the routing DID). */
function sidecarHeaders(contentType?: string): Record<string, string> {
    const h: Record<string, string> = { "X-Ad4m-Did": _did };
    if (contentType) h["Content-Type"] = contentType;
    return h;
}

// ---------------------------------------------------------------------------
// Inline-diff transport (publish + poll)
// ---------------------------------------------------------------------------

/** Topic on which full commit bodies are published for a neighbourhood. */
export function diffTopic(neighbourhoodUrl: string): string {
    return `ad4m/${neighbourhoodUrl}/diffs`;
}

/**
 * An inline commit envelope broadcast over the diff topic: the commit CID (so
 * peers seed their head frontier with it) plus the full commit body (so peers
 * can fold it without a cross-node block fetch).
 */
export interface InlineCommitMessage {
    type: "inline-commit";
    did: DID;
    cid: string;
    commit: PerspectiveCommitNode;
    timestamp: number;
}

/** Type guard for an inline-commit envelope. */
export function isInlineCommitMessage(v: unknown): v is InlineCommitMessage {
    if (!v || typeof v !== "object") return false;
    const m = v as Record<string, unknown>;
    return (
        m.type === "inline-commit" &&
        typeof m.cid === "string" &&
        typeof m.did === "string" &&
        !!m.commit &&
        typeof m.commit === "object"
    );
}

/**
 * Publish a commit body inline over the neighbourhood diff topic via the
 * sidecar's `POST /publish`. Best-effort; the caller logs failures.
 */
export async function publishInlineCommit(
    neighbourhoodUrl: string,
    cid: string,
    commit: PerspectiveCommitNode,
): Promise<void> {
    const msg: InlineCommitMessage = {
        type: "inline-commit",
        did: _did,
        cid,
        commit,
        timestamp: Date.now(),
    };
    const body = JSON.stringify({ topic: diffTopic(neighbourhoodUrl), data: JSON.stringify(msg) });
    const target = `${sidecarUrl()}/publish`;
    const headers = sidecarHeaders("application/json");

    let res = await getTransport().fetch(target, "POST", headers, body);
    // Retry a TRANSPORT failure (status 0) on a fresh connection. Re-publishing
    // the same inline commit is harmless: peers key it by CID and the OR-Set
    // fold is idempotent, so a duplicate delivery folds to the identical state.
    for (let attempt = 0; res.status === 0 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 50));
        res = await getTransport().fetch(target, "POST", headers, body);
    }
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`sidecar /publish failed: HTTP ${res.status} — ${res.body}`);
    }
}

// ---------------------------------------------------------------------------
// Poll cursor (per topic, persisted so restarts resume)
// ---------------------------------------------------------------------------

const CURSOR_PREFIX = "sidecar:cursor/";

function cursorKey(topic: string): number {
    const raw = getStorage().get(`${CURSOR_PREFIX}${topic}`);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
}

function setCursor(topic: string, seq: number): void {
    getStorage().put(`${CURSOR_PREFIX}${topic}`, String(seq));
}

interface SidecarMessage {
    seq: number;
    from: string;
    data: string;
}

/**
 * Poll the sidecar for new messages on a topic since our persisted cursor,
 * advancing the cursor past everything returned. Returns the raw message
 * payload strings (the `data` field), newest last.
 *
 * A `status: 0` response is a TRANSPORT-level failure (the sandbox's httpFetch
 * threw — e.g. a pooled keep-alive socket the sidecar retired between polls,
 * surfacing as hyper's "connection closed before message completed"). That poll
 * is safe to retry: GET is idempotent and the sidecar's message buffer is
 * cursor-stateless (it filters by the `since` we send and never advances a
 * server-side cursor), so a retry re-fetches exactly the same tail. Retrying
 * here — rather than dropping the poll — is what stops a single stale socket
 * from swallowing the inline commit that a peer needs to converge.
 */
export async function pollTopic(topic: string): Promise<string[]> {
    const since = cursorKey(topic);
    const url = `${sidecarUrl()}/messages?topic=${encodeURIComponent(topic)}&since=${since}`;

    let res = await getTransport().fetch(url, "GET", sidecarHeaders(), "");
    for (let attempt = 0; res.status === 0 && attempt < 3; attempt++) {
        // Transport error (not an HTTP status): back off briefly and retry on a
        // fresh connection. Bounded so a genuinely-down sidecar still surfaces.
        await new Promise((r) => setTimeout(r, 50));
        res = await getTransport().fetch(url, "GET", sidecarHeaders(), "");
    }

    if (res.status < 200 || res.status >= 300) {
        throw new Error(`sidecar /messages failed: HTTP ${res.status} — ${res.body}`);
    }
    let parsed: { messages?: SidecarMessage[]; nextSeq?: number };
    try {
        parsed = JSON.parse(res.body);
    } catch {
        return [];
    }
    const messages = parsed.messages || [];
    if (typeof parsed.nextSeq === "number" && parsed.nextSeq >= since) {
        setCursor(topic, parsed.nextSeq);
    }
    return messages.map((m) => m.data).filter((d): d is string => typeof d === "string");
}

// ---------------------------------------------------------------------------
// Commit-body cache (populated by inline diffs; read by fetchCommit)
// ---------------------------------------------------------------------------

const COMMIT_CACHE_PREFIX = "sidecar:commit/";

/**
 * Store a commit body under its CID so the DAG walk can resolve it locally.
 * This is what lets a peer fold another node's history without bitswap: the
 * body arrived inline over pubsub, not as a fetched block.
 */
export function cacheCommit(cid: string, commit: PerspectiveCommitNode): void {
    getStorage().put(`${COMMIT_CACHE_PREFIX}${cid}`, JSON.stringify(commit));
}

/**
 * Look up a cached commit body by CID, or null if not present.
 */
export function getCachedCommit(cid: string): PerspectiveCommitNode | null {
    const raw = getStorage().get(`${COMMIT_CACHE_PREFIX}${cid}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as PerspectiveCommitNode;
    } catch {
        return null;
    }
}
