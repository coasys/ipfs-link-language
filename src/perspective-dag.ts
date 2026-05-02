/**
 * Perspective DAG structure — linked list of commit nodes.
 *
 * Stores and retrieves PerspectiveCommitNodes on IPFS,
 * manages the commit chain, and handles DAG traversal.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import { linksToNodes, nodesToLinks } from "./translate.pure.js";
import type { LinkNode } from "./translate.pure.js";
import {
    buildCommitNode,
    buildGenesisCommit,
    getPreviousCid,
    isValidCommitNode,
} from "./perspective-dag.pure.js";
import type { PerspectiveCommitNode } from "./perspective-dag.pure.js";
import { ipfsDagPut, ipfsDagGet } from "./ipfs-api.js";
import { getStorage } from "./storage-interface.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEAD_KEY = "ipfs:sync:head";
const IPNS_KEY_NAME_KEY = "ipfs:ipns:key:name";

// ---------------------------------------------------------------------------
// Head management
// ---------------------------------------------------------------------------

/**
 * Get the current head CID (latest commit in the chain).
 */
export function getHeadCid(): string | null {
    return getStorage().get(HEAD_KEY);
}

/**
 * Set the current head CID.
 */
export function setHeadCid(cid: string): void {
    getStorage().put(HEAD_KEY, cid);
}

/**
 * Get the IPNS key name for this Neighbourhood.
 */
export function getIpnsKeyName(): string | null {
    return getStorage().get(IPNS_KEY_NAME_KEY);
}

/**
 * Set the IPNS key name for this Neighbourhood.
 */
export function setIpnsKeyName(name: string): void {
    getStorage().put(IPNS_KEY_NAME_KEY, name);
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

/**
 * Create a new commit from a PerspectiveDiff, store it on IPFS,
 * and update the local head.
 *
 * Returns the CID of the new commit node.
 */
export async function createCommit(
    apiUrl: string,
    diff: PerspectiveDiff,
    author: string,
    pin: boolean = true,
): Promise<string> {
    const previousCid = getHeadCid();
    const additions = linksToNodes(diff.additions);
    const removals = linksToNodes(diff.removals);

    const commitNode = previousCid
        ? buildCommitNode(author, additions, removals, previousCid)
        : buildGenesisCommit(author, additions);

    const cid = await ipfsDagPut(apiUrl, commitNode, pin);
    setHeadCid(cid);

    return cid;
}

/**
 * Fetch a commit node from IPFS by CID.
 */
export async function fetchCommit(
    apiUrl: string,
    cid: string,
): Promise<PerspectiveCommitNode> {
    const data = await ipfsDagGet<PerspectiveCommitNode>(apiUrl, cid);
    if (!isValidCommitNode(data)) {
        throw new Error(`Invalid commit node at CID ${cid}`);
    }
    return data;
}

/**
 * Walk the commit chain from a starting CID back to a stop CID
 * (or genesis if stopCid is null).
 *
 * Returns commits in reverse chronological order (newest first).
 */
export async function walkCommitChain(
    apiUrl: string,
    startCid: string,
    stopCid: string | null = null,
    maxDepth: number = 1000,
): Promise<PerspectiveCommitNode[]> {
    const commits: PerspectiveCommitNode[] = [];
    let currentCid: string | null = startCid;
    let depth = 0;

    while (currentCid && depth < maxDepth) {
        if (currentCid === stopCid) break;

        const commit = await fetchCommit(apiUrl, currentCid);
        commits.push(commit);

        currentCid = getPreviousCid(commit);
        depth++;
    }

    return commits;
}

/**
 * Collect all links from a chain of commits into a PerspectiveDiff.
 *
 * Commits should be in reverse chronological order (newest first).
 * The diff accumulates all additions and removals.
 */
export function collectDiffFromCommits(
    commits: PerspectiveCommitNode[],
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    // Process in chronological order (reverse the array)
    const chronological = [...commits].reverse();

    for (const commit of chronological) {
        additions.push(...nodesToLinks(commit.additions));
        removals.push(...nodesToLinks(commit.removals));
    }

    return { additions, removals };
}

// Re-export pure functions
export {
    buildCommitNode,
    buildGenesisCommit,
    getPreviousCid,
    isValidCommitNode,
    commitSize,
    chainCommits,
} from "./perspective-dag.pure.js";
export type { PerspectiveCommitNode, NeighbourhoodMeta } from "./perspective-dag.pure.js";
