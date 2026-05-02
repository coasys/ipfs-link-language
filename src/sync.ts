/**
 * Sync via IPNS resolution + DAG traversal.
 *
 * Sync algorithm per Spec §5:
 * 1. Resolve IPNS → latest commit CID
 * 2. Fetch commit node via dag/get
 * 3. Walk `previous` links to find commits since last sync
 * 4. Accumulate additions/removals → PerspectiveDiff
 * 5. Store the resolved CID in KV as sync cursor: `ipfs:sync:head`
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import { ipnsResolve } from "./ipfs-api.js";
import {
    getHeadCid,
    setHeadCid,
    walkCommitChain,
    collectDiffFromCommits,
} from "./perspective-dag.js";
import * as store from "./store.js";

// ---------------------------------------------------------------------------
// Sync from IPNS
// ---------------------------------------------------------------------------

/**
 * Sync from an IPNS name by resolving it and walking the commit chain.
 *
 * Returns the PerspectiveDiff of new changes since the last sync.
 */
export async function syncFromIPNS(
    apiUrl: string,
    ipnsName: string,
): Promise<PerspectiveDiff> {
    // 1. Resolve IPNS → latest commit CID
    let latestCid: string;
    try {
        latestCid = await ipnsResolve(apiUrl, ipnsName);
    } catch {
        // IPNS resolution failed — no changes
        return { additions: [], removals: [] };
    }

    if (!latestCid) {
        return { additions: [], removals: [] };
    }

    // 2. Check if we're already at the latest
    const currentHead = getHeadCid();
    if (currentHead === latestCid) {
        return { additions: [], removals: [] };
    }

    // 3. Walk the commit chain from latest back to current head
    const commits = await walkCommitChain(apiUrl, latestCid, currentHead);

    if (commits.length === 0) {
        return { additions: [], removals: [] };
    }

    // 4. Collect all changes into a PerspectiveDiff
    const diff = collectDiffFromCommits(commits);

    // 5. Apply to local store
    store.applyDiff(diff);

    // 6. Update head cursor
    setHeadCid(latestCid);
    store.setRevision(latestCid);

    return diff;
}

/**
 * Sync from a known CID directly (bypasses IPNS resolution).
 * Useful for fast sync when the CID is known from another channel.
 */
export async function syncFromCID(
    apiUrl: string,
    targetCid: string,
): Promise<PerspectiveDiff> {
    const currentHead = getHeadCid();
    if (currentHead === targetCid) {
        return { additions: [], removals: [] };
    }

    const commits = await walkCommitChain(apiUrl, targetCid, currentHead);

    if (commits.length === 0) {
        return { additions: [], removals: [] };
    }

    const diff = collectDiffFromCommits(commits);
    store.applyDiff(diff);
    setHeadCid(targetCid);
    store.setRevision(targetCid);

    return diff;
}

/**
 * Full initial sync — walk the entire DAG from root.
 * Used on cold start when there's no local state.
 */
export async function fullSync(
    apiUrl: string,
    rootCid: string,
): Promise<PerspectiveDiff> {
    const commits = await walkCommitChain(apiUrl, rootCid, null);

    if (commits.length === 0) {
        return { additions: [], removals: [] };
    }

    const diff = collectDiffFromCommits(commits);
    store.applyDiff(diff);
    setHeadCid(rootCid);
    store.setRevision(rootCid);

    return diff;
}
