/**
 * Link ↔ IPLD node translation — with IPFS storage integration.
 *
 * Uses the IPFS HTTP API to store and retrieve link nodes as DAG-JSON.
 * Maintains the AD4M hash ↔ IPFS CID mapping.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import { linkToNode, nodeToLink, linkContentKey, linksToNodes, nodesToLinks } from "./translate.pure.js";
import type { LinkNode } from "./translate.pure.js";
import { ipfsDagPut, ipfsDagGet } from "./ipfs-api.js";
import { storeCidMapping, computeHash } from "./cid.js";

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

// Re-export pure functions
export {
    linkToNode,
    nodeToLink,
    linkContentKey,
    linksToNodes,
    nodesToLinks,
    isValidLinkNode,
} from "./translate.pure.js";
export type { LinkNode } from "./translate.pure.js";
