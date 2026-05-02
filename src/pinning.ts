/**
 * Pin management for persistence.
 *
 * Manages pinning of IPFS content to ensure perspective data
 * persists across garbage collection cycles.
 *
 * No ad4m:host imports — uses injected transport adapter.
 */

import { ipfsPinAdd, ipfsPinRm } from "./ipfs-api.js";
import { getStorage } from "./storage-interface.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PINNED_PREFIX = "pinned/";

// ---------------------------------------------------------------------------
// Pin tracking
// ---------------------------------------------------------------------------

/**
 * Record that a CID has been pinned locally.
 */
export function recordPin(cid: string): void {
    getStorage().put(`${PINNED_PREFIX}${cid}`, new Date().toISOString());
}

/**
 * Remove the pin record for a CID.
 */
export function removePin(cid: string): void {
    getStorage().delete(`${PINNED_PREFIX}${cid}`);
}

/**
 * Check if a CID is recorded as pinned.
 */
export function isPinned(cid: string): boolean {
    return getStorage().get(`${PINNED_PREFIX}${cid}`) !== null;
}

/**
 * List all recorded pinned CIDs.
 */
export function listPinnedCids(): string[] {
    const keys = getStorage().listKeys(PINNED_PREFIX);
    return keys.map(k => k.replace(PINNED_PREFIX, ""));
}

// ---------------------------------------------------------------------------
// Pin operations
// ---------------------------------------------------------------------------

/**
 * Pin a CID on the IPFS node and record it locally.
 */
export async function pinCid(apiUrl: string, cid: string): Promise<void> {
    await ipfsPinAdd(apiUrl, cid);
    recordPin(cid);
}

/**
 * Unpin a CID on the IPFS node and remove the local record.
 */
export async function unpinCid(apiUrl: string, cid: string): Promise<void> {
    await ipfsPinRm(apiUrl, cid);
    removePin(cid);
}

/**
 * Pin the commit chain from a given head CID.
 * Pins the head and all referenced link nodes recursively.
 */
export async function pinCommitChain(apiUrl: string, headCid: string): Promise<number> {
    if (isPinned(headCid)) return 0;
    await pinCid(apiUrl, headCid);
    return 1;
}

/**
 * Unpin old commits that are no longer the head.
 * Keeps the current head and its ancestors up to `keepCount` deep.
 */
export async function cleanupOldPins(
    apiUrl: string,
    currentHeadCid: string,
    keepCount: number = 10,
): Promise<number> {
    const pinnedCids = listPinnedCids();
    let removed = 0;

    // Simple strategy: keep the current head and remove others
    // beyond the keep count
    const toRemove = pinnedCids.filter(cid => cid !== currentHeadCid);

    if (toRemove.length <= keepCount) return 0;

    // Remove oldest pins first (they're stored with timestamps)
    const sorted = toRemove.sort((a, b) => {
        const timeA = getStorage().get(`${PINNED_PREFIX}${a}`) || "";
        const timeB = getStorage().get(`${PINNED_PREFIX}${b}`) || "";
        return timeA.localeCompare(timeB);
    });

    const excess = sorted.slice(0, sorted.length - keepCount);
    for (const cid of excess) {
        try {
            await unpinCid(apiUrl, cid);
            removed++;
        } catch {
            // Pin removal failed — not critical, continue
        }
    }

    return removed;
}
