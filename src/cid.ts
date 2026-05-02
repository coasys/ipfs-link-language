/**
 * CID utilities — wraps pure CID functions with runtime adapter integration.
 *
 * CRITICAL: AD4M hash() ≠ IPFS CID — different framing.
 * This module maintains the mapping between AD4M hashes and IPFS CIDs.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import { getStorage } from "./storage-interface.js";
import { getRuntime } from "./runtime-interface.js";
import { buildCIDv1, parseCID, isCID } from "./cid.pure.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DAG-JSON multicodec code */
export const DAG_JSON_CODEC = 0x0129;
/** SHA-256 multihash function code */
export const SHA256_CODE = 0x12;

// ---------------------------------------------------------------------------
// CID ↔ AD4M hash mapping
// ---------------------------------------------------------------------------

const CID_MAP_PREFIX = "cid-map/";
const REVERSE_CID_MAP_PREFIX = "cid-reverse/";

/**
 * Store a mapping between an AD4M hash and an IPFS CID.
 */
export function storeCidMapping(ad4mHash: string, ipfsCid: string): void {
    const storage = getStorage();
    storage.put(`${CID_MAP_PREFIX}${ad4mHash}`, ipfsCid);
    storage.put(`${REVERSE_CID_MAP_PREFIX}${ipfsCid}`, ad4mHash);
}

/**
 * Look up the IPFS CID for an AD4M hash.
 */
export function cidForHash(ad4mHash: string): string | null {
    return getStorage().get(`${CID_MAP_PREFIX}${ad4mHash}`);
}

/**
 * Look up the AD4M hash for an IPFS CID.
 */
export function hashForCid(ipfsCid: string): string | null {
    return getStorage().get(`${REVERSE_CID_MAP_PREFIX}${ipfsCid}`);
}

/**
 * Compute AD4M hash for arbitrary data using the runtime adapter.
 */
export function computeHash(data: string): string {
    return getRuntime().hash(data);
}

// Re-export pure CID functions for convenience
export { buildCIDv1, parseCID, isCID } from "./cid.pure.js";
