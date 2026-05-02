/**
 * Pure DAG node construction for Perspective commit chain — zero runtime deps.
 *
 * Perspective stored as a linked list of commit nodes per Spec §2.4:
 *
 * ```
 * PerspectiveCommitNode {
 *   type: "ad4m:PerspectiveCommit"
 *   previous: { "/": "<cid>" } | null
 *   author: "<did:key>"
 *   timestamp: "<ISO-8601>"
 *   additions: LinkNode[]
 *   removals: LinkNode[]
 * }
 * ```
 *
 * Each commit is DAG-JSON encoded and stored via dag/put → returns CID.
 * The Neighbourhood's IPNS key points to the latest commit CID.
 */

import type { LinkNode } from "./translate.pure.js";
import type { DagJsonLink } from "./ipld.pure.js";

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
