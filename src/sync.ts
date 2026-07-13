/**
 * Sync via per-agent IPNS heads + multi-parent DAG traversal + OR-Set merge.
 *
 * This is the AD4M perspective-sync contract for IPFS. IPFS gives us a real
 * content-addressed commit DAG; the only thing missing from genuine
 * multi-writer convergence was that a single IPNS name is single-writer
 * (concurrent publishers clobber each other, last-writer-wins). We fix that:
 *
 *  1. Each agent publishes ITS OWN head under ITS OWN IPNS name.
 *  2. Sync discovers every peer's head (the head frontier) instead of reading
 *     one shared pointer.
 *  3. The whole frontier is walked (multi-parent DAG walk), folded via an
 *     OR-Set keyed by link hash, and applied to the derived local store.
 *  4. When the frontier has more than one un-merged head, we create a merge
 *     commit whose parents are all the heads and whose materialised state is
 *     the OR-Set union — and republish our own IPNS head to point at it.
 *  5. `currentRevision` is a content hash of the head frontier (single CID, or
 *     a digest of the sorted head CIDs) — never a cursor/timestamp.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { PerspectiveDiff } from "./types.js";
import { ipnsResolve } from "./ipfs-api.js";
import {
    getHeadCid,
    setHeadCid,
    setPeerHead,
    currentHeads,
    walkDag,
    foldCommits,
    collectDiffFromCommits,
    createMergeCommit,
    revisionFromHeads,
} from "./perspective-dag.js";
import * as store from "./store.js";

// ---------------------------------------------------------------------------
// Head discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a single peer's IPNS name to its head commit CID and record it in
 * the local head frontier. Returns the resolved CID, or null on failure.
 */
export async function discoverPeerHead(
    apiUrl: string,
    peerIpnsName: string,
): Promise<string | null> {
    let cid: string;
    try {
        cid = await ipnsResolve(apiUrl, peerIpnsName);
    } catch {
        return null;
    }
    if (!cid) return null;
    setPeerHead(peerIpnsName, cid);
    return cid;
}

/**
 * Resolve many peers' IPNS names, recording each discovered head.
 * Returns the list of successfully-resolved head CIDs.
 */
export async function discoverPeerHeads(
    apiUrl: string,
    peerIpnsNames: string[],
): Promise<string[]> {
    const heads: string[] = [];
    for (const name of peerIpnsNames) {
        const cid = await discoverPeerHead(apiUrl, name);
        if (cid) heads.push(cid);
    }
    return heads;
}

// ---------------------------------------------------------------------------
// Converge: walk the frontier, fold, apply, (optionally) merge
// ---------------------------------------------------------------------------

/**
 * Options for {@link converge}.
 */
export interface ConvergeOptions {
    /**
     * If set (and there is more than one un-merged head), a merge commit is
     * created authored by this DID, its IPNS head is updated to the merge CID,
     * and `publishHead` is invoked with the merge CID.
     */
    mergeAuthor?: string;
    /**
     * Publish this agent's new head after a merge (e.g. IPNS name/publish).
     * Called only when a merge commit is created.
     */
    publishHead?: (cid: string) => Promise<void>;
    /**
     * Broadcast a newly-created MERGE commit body inline (over the pubsub diff
     * topic), so peers can fold across it from their local cache. Without this,
     * a peer's later commit whose parent is this merge forces a cross-node
     * `dag/get` that can never succeed on Kubo 0.42.0 (bitswap does not transfer
     * blocks between directly-peered nodes) and blocks the walk on its timeout.
     * Called only when a merge commit is created, with the merge CID.
     */
    publishMerge?: (cid: string) => Promise<void>;
    /** Pin merge commits locally. Default true. */
    pin?: boolean;
}

/**
 * The outcome of a convergence pass.
 */
export interface ConvergeResult {
    /** The diff applied to the local store to reach the converged link set. */
    diff: PerspectiveDiff;
    /** The head frontier after convergence. */
    heads: string[];
    /** The content-hash revision after convergence. */
    revision: string;
    /** The merge commit CID, if a merge was created. */
    mergeCid: string | null;
}

/**
 * Converge the local replica against the current head frontier.
 *
 * Walks every head's ancestry (multi-parent), folds via OR-Set, applies the
 * derived diff to the local store, and — if there is genuine divergence and a
 * `mergeAuthor` is supplied — creates a deterministic merge commit.
 */
export async function converge(
    apiUrl: string,
    opts: ConvergeOptions = {},
): Promise<ConvergeResult> {
    const heads = currentHeads();

    if (heads.length === 0) {
        return { diff: { additions: [], removals: [] }, heads, revision: "", mergeCid: null };
    }

    // Walk the whole frontier's ancestry (deduped across shared history).
    const withCids = await walkDag(apiUrl, heads);
    const commits = withCids.map((x) => x.commit);

    // Fold via OR-Set and materialise the derived diff for the local store.
    const diff = collectDiffFromCommits(commits);
    store.applyDiff(diff);

    // Divergence: more than one distinct head that isn't already an ancestor
    // of another. `walkDag` deduped shared history, so if >1 head remain
    // distinct we have concurrent branches to merge.
    const distinctHeads = resolveTips(withCids, heads);

    let mergeCid: string | null = null;
    let finalHeads = distinctHeads;

    if (distinctHeads.length > 1 && opts.mergeAuthor) {
        mergeCid = await createMergeCommit(apiUrl, distinctHeads, opts.mergeAuthor, opts.pin ?? true);
        // Broadcast the merge body inline BEFORE advancing IPNS, so a peer that
        // later builds on this merge can fold across it from cache rather than
        // blocking on a cross-node block fetch that cannot complete.
        if (opts.publishMerge) {
            await opts.publishMerge(mergeCid);
        }
        if (opts.publishHead) {
            await opts.publishHead(mergeCid);
        }
        finalHeads = [mergeCid];
    } else if (distinctHeads.length === 1) {
        // Single converged head — adopt it as our own head.
        setHeadCid(distinctHeads[0]);
    }

    const revision = revisionFromHeads(finalHeads);
    store.setRevision(revision);

    return { diff, heads: finalHeads, revision, mergeCid };
}

/**
 * From a walked DAG, compute the set of TIP CIDs: heads that are not an
 * ancestor of any other head. If one supplied head is reachable from another,
 * it is not a tip and is dropped (the reachable-from head subsumes it).
 */
function resolveTips(walked: Array<{ cid: string; commit: { previous: Array<{ "/": string }> } }>, heads: string[]): string[] {
    // Build the set of all CIDs that appear as a parent of some walked node.
    const isParentOfSomething = new Set<string>();
    for (const { commit } of walked) {
        for (const p of commit.previous || []) {
            if (p && p["/"]) isParentOfSomething.add(p["/"]);
        }
    }
    const tips = [...new Set(heads)].filter((h) => !isParentOfSomething.has(h));
    return tips.length > 0 ? tips.sort() : [...new Set(heads)].sort();
}

// ---------------------------------------------------------------------------
// Sync from a set of peer IPNS names (discover + converge)
// ---------------------------------------------------------------------------

/**
 * Full sync entry point: discover the given peers' heads, then converge.
 *
 * Returns the diff applied to the local store during convergence.
 */
export async function syncFromPeers(
    apiUrl: string,
    peerIpnsNames: string[],
    opts: ConvergeOptions = {},
): Promise<PerspectiveDiff> {
    await discoverPeerHeads(apiUrl, peerIpnsNames);
    const res = await converge(apiUrl, opts);
    return res.diff;
}

/**
 * Sync from a single IPNS name (this agent's own, or a shared bootstrap name).
 * Records the resolved head into the frontier, then converges.
 *
 * Kept for the common single-peer / bootstrap case and for the language's
 * initial-sync path.
 */
export async function syncFromIPNS(
    apiUrl: string,
    ipnsName: string,
    opts: ConvergeOptions = {},
): Promise<PerspectiveDiff> {
    await discoverPeerHead(apiUrl, ipnsName);
    const res = await converge(apiUrl, opts);
    return res.diff;
}

// ---------------------------------------------------------------------------
// Sync from a known CID directly (bypasses IPNS resolution)
// ---------------------------------------------------------------------------

/**
 * Sync from a known head CID directly, recording it as a peer head then
 * converging. Useful for fast sync when a head CID is known out-of-band
 * (e.g. via PubSub).
 */
export async function syncFromCID(
    apiUrl: string,
    targetCid: string,
    opts: ConvergeOptions = {},
): Promise<PerspectiveDiff> {
    setPeerHead(`cid:${targetCid}`, targetCid);
    const res = await converge(apiUrl, opts);
    return res.diff;
}

/**
 * Full initial sync from a single root/head CID on a cold start.
 * Walks the entire DAG from the head and folds it into the local store.
 */
export async function fullSync(
    apiUrl: string,
    rootCid: string,
): Promise<PerspectiveDiff> {
    const withCids = await walkDag(apiUrl, [rootCid]);
    const commits = withCids.map((x) => x.commit);

    if (commits.length === 0) {
        return { additions: [], removals: [] };
    }

    // On cold start the store is empty, so only live additions matter.
    const { links } = foldCommits(commits);
    const diff: PerspectiveDiff = { additions: [...links.values()], removals: [] };
    store.applyDiff(diff);
    setHeadCid(rootCid);
    store.setRevision(revisionFromHeads([rootCid]));

    return diff;
}
