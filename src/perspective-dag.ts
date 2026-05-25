/**
 * Perspective DAG structure — linked list of commit nodes.
 *
 * Stores and retrieves PerspectiveCommitNodes on IPFS,
 * manages the commit chain, and handles DAG traversal.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import { linksToNodes, nodesToLinks } from "./translate.js";
import type { LinkNode } from "./translate.js";
import type { DagJsonLink } from "./ipld.js";
import { ipfsDagPut, ipfsDagGet } from "./ipfs-api.js";
import { getStorage } from "./adapters.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Perspective commit node in the DAG chain.
 */
export interface PerspectiveCommitNode {
    type: "ad4m:PerspectiveCommit";
    previous: DagJsonLink | null;
    author: string;
    timestamp: string;
    additions: LinkNode[];
    removals: LinkNode[];
}

/**
 * Metadata about a Neighbourhood for the root commit.
 */
export interface NeighbourhoodMeta {
    name: string;
    description?: string;
    created: string;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a PerspectiveCommitNode.
 *
 * @param author      DID of the committing agent
 * @param additions   LinkNodes being added
 * @param removals    LinkNodes being removed
 * @param previousCid CID of the previous commit (null for genesis)
 * @param timestamp   ISO-8601 timestamp (defaults to now)
 */
export function buildCommitNode(
    author: string,
    additions: LinkNode[],
    removals: LinkNode[],
    previousCid: string | null,
    timestamp?: string,
): PerspectiveCommitNode {
    return {
        type: "ad4m:PerspectiveCommit",
        previous: previousCid ? { "/": previousCid } : null,
        author,
        timestamp: timestamp || new Date().toISOString(),
        additions,
        removals,
    };
}

/**
 * Validate that a value is a valid PerspectiveCommitNode.
 */
export function isValidCommitNode(value: unknown): value is PerspectiveCommitNode {
    if (!value || typeof value !== "object") return false;
    const node = value as Record<string, unknown>;
    return (
        node.type === "ad4m:PerspectiveCommit" &&
        typeof node.author === "string" &&
        typeof node.timestamp === "string" &&
        Array.isArray(node.additions) &&
        Array.isArray(node.removals) &&
        (node.previous === null || (typeof node.previous === "object" && node.previous !== null))
    );
}

/**
 * Extract the previous CID from a commit node, if present.
 */
export function getPreviousCid(node: PerspectiveCommitNode): string | null {
    if (!node.previous) return null;
    return node.previous["/"] || null;
}

/**
 * Count total link changes in a commit.
 */
export function commitSize(node: PerspectiveCommitNode): number {
    return node.additions.length + node.removals.length;
}

/**
 * Build a genesis commit node (first commit, no previous).
 */
export function buildGenesisCommit(
    author: string,
    additions: LinkNode[],
    timestamp?: string,
): PerspectiveCommitNode {
    return buildCommitNode(author, additions, [], null, timestamp);
}

/**
 * Chain multiple commit nodes by setting the previous CID of each.
 * Returns the nodes in order with `previous` set.
 * The first node has `previous = null`.
 */
export function chainCommits(
    commits: Array<{ author: string; additions: LinkNode[]; removals: LinkNode[]; timestamp?: string }>,
    startCid: string | null = null,
    cidGenerator: (index: number) => string,
): PerspectiveCommitNode[] {
    const result: PerspectiveCommitNode[] = [];
    let prevCid = startCid;

    for (let i = 0; i < commits.length; i++) {
        const commit = commits[i];
        const node = buildCommitNode(
            commit.author,
            commit.additions,
            commit.removals,
            prevCid,
            commit.timestamp,
        );
        result.push(node);
        prevCid = cidGenerator(i);
    }

    return result;
}


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
