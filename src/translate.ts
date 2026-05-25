/**
 * Link ↔ IPLD node translation — with IPFS storage integration.
 *
 * Uses the IPFS HTTP API to store and retrieve link nodes as DAG-JSON.
 * Maintains the AD4M hash ↔ IPFS CID mapping.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import { ipfsDagPut, ipfsDagGet } from "./ipfs-api.js";
import { storeCidMapping, computeHash } from "./cid.js";

// ---------------------------------------------------------------------------
// IPLD Node Types (DAG-JSON)
// ---------------------------------------------------------------------------

/**
 * An AD4M LinkExpression as an IPLD DAG-JSON node.
 */
export interface LinkNode {
    type: "ad4m:LinkExpression";
    source: string;
    predicate: string;
    target: string;
    author: string;
    timestamp: string;
    proof: {
        signature: string;
        key: string;
    };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to an IPLD LinkNode (DAG-JSON).
 */
export function linkToNode(link: LinkExpression): LinkNode {
    return {
        type: "ad4m:LinkExpression",
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
        proof: {
            signature: link.proof?.signature || "",
            key: link.proof?.key || "",
        },
    };
}

/**
 * Convert an IPLD LinkNode (DAG-JSON) back to a LinkExpression.
 */
export function nodeToLink(node: LinkNode): LinkExpression {
    return {
        author: node.author,
        timestamp: node.timestamp,
        data: {
            source: node.source,
            target: node.target,
            predicate: node.predicate,
        },
        proof: {
            signature: node.proof?.signature || "",
            key: node.proof?.key || "",
        },
    };
}

/**
 * Compute a deterministic content key for a LinkExpression.
 * Used for deduplication and indexing.
 */
export function linkContentKey(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
    });
}

/**
 * Validate that a LinkNode has all required fields.
 */
export function isValidLinkNode(node: unknown): node is LinkNode {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    return (
        n.type === "ad4m:LinkExpression" &&
        typeof n.source === "string" &&
        typeof n.predicate === "string" &&
        typeof n.target === "string" &&
        typeof n.author === "string" &&
        typeof n.timestamp === "string" &&
        typeof n.proof === "object" &&
        n.proof !== null
    );
}

/**
 * Batch convert LinkExpressions to LinkNodes.
 */
export function linksToNodes(links: LinkExpression[]): LinkNode[] {
    return links.map(linkToNode);
}

/**
 * Batch convert LinkNodes to LinkExpressions.
 */
export function nodesToLinks(nodes: LinkNode[]): LinkExpression[] {
    return nodes.map(nodeToLink);
}


// ---------------------------------------------------------------------------
// Store link as IPLD node
// ---------------------------------------------------------------------------

/**
 * Store a LinkExpression as an IPLD DAG-JSON node on IPFS.
 * Returns the IPFS CID and stores the hash ↔ CID mapping.
 */
export async function storeLinkOnIPFS(
    apiUrl: string,
    link: LinkExpression,
    pin: boolean = true,
): Promise<string> {
    const node = linkToNode(link);
    const cid = await ipfsDagPut(apiUrl, node, pin);

    // Store the bidirectional mapping
    const ad4mHash = computeHash(linkContentKey(link));
    storeCidMapping(ad4mHash, cid);

    return cid;
}

/**
 * Retrieve a LinkExpression from IPFS by CID.
 */
export async function fetchLinkFromIPFS(
    apiUrl: string,
    cid: string,
): Promise<LinkExpression> {
    const node = await ipfsDagGet<LinkNode>(apiUrl, cid);
    return nodeToLink(node);
}

/**
 * Store all links from a PerspectiveDiff on IPFS.
 * Returns a map of AD4M hash → IPFS CID.
 */
export async function storeDiffLinksOnIPFS(
    apiUrl: string,
    diff: PerspectiveDiff,
    pin: boolean = true,
): Promise<Map<string, string>> {
    const cidMap = new Map<string, string>();

    for (const link of diff.additions) {
        const cid = await storeLinkOnIPFS(apiUrl, link, pin);
        const ad4mHash = computeHash(linkContentKey(link));
        cidMap.set(ad4mHash, cid);
    }

    return cidMap;
}

// ---------------------------------------------------------------------------
// SDNA / Subject Class pattern detection (was sdna.ts)
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "unknown";
    /** Expression URI to resolve for content */
    contentUri?: string;
    /** For replies: the parent message URI */
    parentUri?: string;
    /** For chat: the channel/conversation URI */
    channelUri?: string;
    /** For mentions: the mentioned agent DID or URI */
    mentionedAgent?: string;
}

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const CONTENT_PREDICATE = "sioc://content_of";

/**
 * Detect the Subject Class pattern of a link based on its predicate.
 *
 * Priority (first match wins):
 * 1. Predicate in `chatPredicates` → chat-message
 * 2. Reply predicates → reply
 * 3. Predicate contains "mention" → mention
 * 4. Reaction predicates → reaction
 * 5. sioc://content_of → content
 * 6. Default → unknown
 */
export function detectPattern(
    link: LinkExpression,
    chatPredicates: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    // 1. Chat message
    if (predicate && chatPredicates.includes(predicate)) {
        return {
            type: "chat-message",
            contentUri: target,
            channelUri: source,
        };
    }

    // 2. Reply
    if (REPLY_PREDICATES.has(predicate)) {
        return {
            type: "reply",
            contentUri: target,
            parentUri: source,
        };
    }

    // 3. Mention
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return {
            type: "mention",
            mentionedAgent: target,
        };
    }

    // 4. Reaction
    if (REACTION_PREDICATES.has(predicate)) {
        return {
            type: "reaction",
            contentUri: target,
        };
    }

    // 5. Content
    if (predicate === CONTENT_PREDICATE) {
        return {
            type: "content",
            contentUri: target,
        };
    }

    // 6. Unknown
    return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// Dual-language deduplication (was dual-language.ts)
// ---------------------------------------------------------------------------

export type LinkOrigin = "ipfs" | "native" | "dual";

/**
 * Compute a canonical content key for dedup comparison.
 * Uses triple only (source, predicate, target) — intentionally
 * excludes author/timestamp so the same logical link from different
 * sync paths is detected as a duplicate.
 */
function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

/**
 * Determine if an outbound link should be published to IPFS.
 *
 * Links that originated from IPFS should NOT be re-published to avoid
 * echo loops. Only "native" or "dual" origin links (or links with
 * no tracked origin, i.e. new local commits) should be published.
 */
export function shouldPublish(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "ipfs";
}

/**
 * Check if a predicate should be excluded from IPFS publication.
 */
export function isExcludedPredicate(
    predicate: string | undefined,
    excludePredicates: string[],
): boolean {
    if (!predicate) return false;
    return excludePredicates.includes(predicate);
}

