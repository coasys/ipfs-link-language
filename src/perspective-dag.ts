/**
 * Perspective DAG — a content-addressed, causal, multi-parent commit DAG.
 *
 * Role A (convergence substrate) of the AD4M perspective-sync contract.
 * The DAG stores link *diffs* (additions + removals) as commit nodes; the
 * materialised link set is *derived* by folding the DAG, never the source
 * of truth.
 *
 * Key properties:
 *  - A commit's `previous` is an ARRAY of parent CIDs, so a commit may have
 *    multiple parents (a merge commit). Genesis has an empty parent array.
 *  - `walkCommitChain` walks ALL ancestors of a set of heads (multi-parent
 *    BFS), deduped by CID, returned in a deterministic order.
 *  - Folding the DAG is an OR-Set (observed-remove set) keyed by the link
 *    content hash: union of adds minus tombstoned removes. Because links are
 *    immutable content-addressed elements, this converges deterministically
 *    with NO scribe/coordinator.
 *
 * No ad4m:host imports — uses injected adapters.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import { linksToNodes, nodesToLinks } from "./translate.js";
import type { LinkNode } from "./translate.js";
import type { DagJsonLink } from "./ipld.js";
import { ipfsDagPut, ipfsDagGet } from "./ipfs-api.js";
import { getStorage, getRuntime } from "./adapters.js";
import { getCachedCommit } from "./sidecar.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Perspective commit node in the DAG.
 *
 * `previous` is the array of parent CIDs (as DAG-JSON links). A genesis
 * commit has `previous: []`. A merge commit has two or more parents.
 */
export interface PerspectiveCommitNode {
    type: "ad4m:PerspectiveCommit";
    previous: DagJsonLink[];
    author: string;
    timestamp: string;
    additions: LinkNode[];
    removals: LinkNode[];
}

/**
 * A legacy single-parent commit node (pre-multi-parent format).
 * Retained ONLY so historical DAGs on IPFS remain walkable. New commits are
 * always written in the multi-parent (`previous: DagJsonLink[]`) format.
 */
interface LegacyCommitNode {
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
// Link content hashing (matches store.hashLink — same fields, same order)
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic content hash of a LinkNode.
 *
 * MUST match `store.hashLink` for the corresponding LinkExpression so that a
 * removal diff (which carries the ORIGINAL link) reconciles against the add
 * of the same link across replicas. Both hash the same five fields in the
 * same order.
 */
export function linkNodeHash(node: LinkNode): string {
    const content = JSON.stringify({
        source: node.source || null,
        predicate: node.predicate || null,
        target: node.target || null,
        author: node.author,
        timestamp: node.timestamp,
    });
    return getRuntime().hash(content);
}

// ---------------------------------------------------------------------------
// Parent-pointer helpers (with legacy read compatibility)
// ---------------------------------------------------------------------------

/**
 * Normalise a commit node's `previous` field to an array of parent CIDs.
 *
 * Accepts:
 *  - the new array form: `previous: [{ "/": cid }, ...]`
 *  - the legacy single-object form: `previous: { "/": cid }`
 *  - the legacy null form: `previous: null`
 */
export function getParentCids(node: PerspectiveCommitNode | LegacyCommitNode): string[] {
    const prev = (node as PerspectiveCommitNode).previous as
        | DagJsonLink[]
        | DagJsonLink
        | null
        | undefined;

    if (!prev) return [];
    if (Array.isArray(prev)) {
        return prev.map((p) => p?.["/"]).filter((c): c is string => typeof c === "string");
    }
    // Legacy single-object form.
    const cid = (prev as DagJsonLink)["/"];
    return typeof cid === "string" ? [cid] : [];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a PerspectiveCommitNode with an arbitrary set of parents.
 *
 * @param author        DID of the committing agent
 * @param additions     LinkNodes being added
 * @param removals      LinkNodes being removed (carry the ORIGINAL link)
 * @param previousCids  CIDs of the parent commits ([] for genesis)
 * @param timestamp     ISO-8601 timestamp (defaults to now)
 */
export function buildCommitNode(
    author: string,
    additions: LinkNode[],
    removals: LinkNode[],
    previousCids: string[] | string | null,
    timestamp?: string,
): PerspectiveCommitNode {
    const parents = normaliseParentArg(previousCids);
    return {
        type: "ad4m:PerspectiveCommit",
        previous: parents.map((cid) => ({ "/": cid })),
        author,
        timestamp: timestamp || new Date().toISOString(),
        additions,
        removals,
    };
}

/**
 * Accept the historical single-CID / null API as well as the new CID-array
 * API so callers and tests can pass either shape.
 */
function normaliseParentArg(previousCids: string[] | string | null): string[] {
    if (previousCids == null) return [];
    if (Array.isArray(previousCids)) return previousCids.filter((c) => typeof c === "string" && c.length > 0);
    return previousCids.length > 0 ? [previousCids] : [];
}

/**
 * Validate that a value is a valid PerspectiveCommitNode (new or legacy shape).
 */
export function isValidCommitNode(value: unknown): value is PerspectiveCommitNode {
    if (!value || typeof value !== "object") return false;
    const node = value as Record<string, unknown>;
    if (node.type !== "ad4m:PerspectiveCommit") return false;
    if (typeof node.author !== "string") return false;
    if (typeof node.timestamp !== "string") return false;
    if (!Array.isArray(node.additions)) return false;
    if (!Array.isArray(node.removals)) return false;
    // previous may be: array of links | single link object | null.
    const prev = node.previous;
    if (prev === null || prev === undefined) return true;
    if (Array.isArray(prev)) return true;
    if (typeof prev === "object") return true;
    return false;
}

/**
 * Extract the parent CIDs from a commit node.
 */
export function getPreviousCids(node: PerspectiveCommitNode): string[] {
    return getParentCids(node);
}

/**
 * Convenience: the FIRST parent CID of a commit, or null for genesis.
 *
 * A merge commit has multiple parents; this returns only the first (sorted)
 * one. Callers that need the full parent set must use {@link getParentCids}.
 */
export function getPreviousCid(node: PerspectiveCommitNode): string | null {
    const parents = getParentCids(node);
    return parents.length > 0 ? parents[0] : null;
}

/**
 * Count total link changes in a commit.
 */
export function commitSize(node: PerspectiveCommitNode): number {
    return node.additions.length + node.removals.length;
}

/**
 * Build a genesis commit node (first commit, no parents).
 */
export function buildGenesisCommit(
    author: string,
    additions: LinkNode[],
    timestamp?: string,
): PerspectiveCommitNode {
    return buildCommitNode(author, additions, [], [], timestamp);
}

/**
 * Build a merge commit: a commit with two or more parents and (typically) no
 * new link diffs of its own. Its materialised state is the OR-Set union of
 * all its ancestors — computed on fold, not stored here.
 *
 * @param author       DID of the agent performing the merge
 * @param parentCids   the head CIDs being merged (must be >= 2 to be a merge)
 * @param additions    optional extra additions to include in the merge
 * @param removals     optional extra removals to include in the merge
 * @param timestamp    ISO-8601 timestamp (defaults to now)
 */
export function buildMergeCommit(
    author: string,
    parentCids: string[],
    additions: LinkNode[] = [],
    removals: LinkNode[] = [],
    timestamp?: string,
): PerspectiveCommitNode {
    // Sort parents so the merge commit is deterministic regardless of the
    // order in which heads were discovered.
    const sortedParents = [...new Set(parentCids)].sort();
    return buildCommitNode(author, additions, removals, sortedParents, timestamp);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Local head pointers (this agent's own head, and the discovered peer heads).
const HEAD_KEY = "ipfs:sync:head";
const PEER_HEADS_PREFIX = "ipfs:peer-head/";
const IPNS_KEY_NAME_KEY = "ipfs:ipns:key:name";
const IPNS_SELF_NAME_KEY = "ipfs:ipns:self:name";

// ---------------------------------------------------------------------------
// Head management (this agent's own head)
// ---------------------------------------------------------------------------

/**
 * Get this agent's current head CID (its own latest commit).
 */
export function getHeadCid(): string | null {
    return getStorage().get(HEAD_KEY);
}

/**
 * Set this agent's current head CID.
 */
export function setHeadCid(cid: string): void {
    getStorage().put(HEAD_KEY, cid);
}

// ---------------------------------------------------------------------------
// Per-agent head frontier (multi-writer)
// ---------------------------------------------------------------------------

/**
 * Record a peer agent's most-recently-seen head CID (keyed by the peer's
 * IPNS name or DID).
 */
export function setPeerHead(peerKey: string, cid: string): void {
    getStorage().put(`${PEER_HEADS_PREFIX}${peerKey}`, cid);
}

/**
 * Get a peer agent's recorded head CID.
 */
export function getPeerHead(peerKey: string): string | null {
    return getStorage().get(`${PEER_HEADS_PREFIX}${peerKey}`);
}

/**
 * List all recorded peer heads as [peerKey, cid] pairs.
 */
export function listPeerHeads(): Array<[string, string]> {
    const keys = getStorage().listKeys(PEER_HEADS_PREFIX);
    const out: Array<[string, string]> = [];
    for (const k of keys) {
        const cid = getStorage().get(k);
        if (cid) out.push([k.slice(PEER_HEADS_PREFIX.length), cid]);
    }
    return out;
}

/**
 * Compute the current head frontier: the set of distinct head CIDs across
 * this agent and all discovered peers. Sorted + deduped for determinism.
 */
export function currentHeads(): string[] {
    const heads = new Set<string>();
    const own = getHeadCid();
    if (own) heads.add(own);
    for (const [, cid] of listPeerHeads()) {
        if (cid) heads.add(cid);
    }
    return [...heads].sort();
}

// ---------------------------------------------------------------------------
// Revision (content hash of the head frontier — the perspective-sync litmus)
// ---------------------------------------------------------------------------

/**
 * Compute the perspective-sync revision from a set of head CIDs.
 *
 *  - 0 heads  → "" (empty perspective, no commits yet)
 *  - 1 head   → that head CID (already a content hash)
 *  - N heads  → a deterministic digest of the sorted head CIDs (a version
 *               vector digest). This is itself a content hash: it changes
 *               deterministically with the set of heads and is stable across
 *               restarts for the same frontier.
 *
 * NEVER a timestamp / cursor / sequence — it is always a hash into the DAG
 * frontier.
 */
export function revisionFromHeads(heads: string[]): string {
    const sorted = [...new Set(heads)].filter(Boolean).sort();
    if (sorted.length === 0) return "";
    if (sorted.length === 1) return sorted[0];
    return getRuntime().hash(sorted.join("\n"));
}

/**
 * Convenience: the revision for the current head frontier.
 */
export function currentRevisionHash(): string {
    return revisionFromHeads(currentHeads());
}

// ---------------------------------------------------------------------------
// IPNS key/name bookkeeping
// ---------------------------------------------------------------------------

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

/**
 * Get this agent's own IPNS name (the pointer peers resolve to read our head).
 */
export function getSelfIpnsName(): string | null {
    return getStorage().get(IPNS_SELF_NAME_KEY);
}

/**
 * Set this agent's own IPNS name.
 */
export function setSelfIpnsName(name: string): void {
    getStorage().put(IPNS_SELF_NAME_KEY, name);
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

/**
 * Create a new commit from a PerspectiveDiff, store it on IPFS, and update
 * the local head. The new commit's parent is this agent's previous head (or
 * genesis if there is none).
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

    const commitNode = buildCommitNode(
        author,
        additions,
        removals,
        previousCid ? [previousCid] : [],
    );

    const cid = await ipfsDagPut(apiUrl, commitNode, pin);
    setHeadCid(cid);

    return cid;
}

/**
 * Create a merge commit joining the given head CIDs, store it on IPFS, and
 * update the local head to the merge CID.
 *
 * The merge commit carries no new link diffs of its own — the materialised
 * state is the OR-Set fold of its ancestors. Returns the merge commit CID.
 */
export async function createMergeCommit(
    apiUrl: string,
    heads: string[],
    author: string,
    pin: boolean = true,
): Promise<string> {
    const mergeNode = buildMergeCommit(author, heads);
    const cid = await ipfsDagPut(apiUrl, mergeNode, pin);
    setHeadCid(cid);
    return cid;
}

/**
 * Fetch a commit node by CID.
 *
 * A locally-cached body wins before any network call. This is what lets the
 * multi-parent DAG walk fold a PEER's history cross-node: on Kubo 0.42.0 two
 * directly-peered nodes never negotiate `/ipfs/bitswap`, so `dag/get` of a
 * peer's CID cannot transfer the block. Instead peers publish each commit body
 * INLINE over pubsub (see sidecar.ts); the receive path caches it under its
 * CID, and the walk resolves it from cache. Own commits, and any block the
 * local node already holds, still resolve via `ipfsDagGet`.
 */
export async function fetchCommit(
    apiUrl: string,
    cid: string,
): Promise<PerspectiveCommitNode> {
    const cached = getCachedCommit(cid);
    if (cached && isValidCommitNode(cached)) {
        return cached;
    }
    const data = await ipfsDagGet<PerspectiveCommitNode>(apiUrl, cid);
    if (!isValidCommitNode(data)) {
        throw new Error(`Invalid commit node at CID ${cid}`);
    }
    return data;
}

// ---------------------------------------------------------------------------
// Multi-parent DAG walk
// ---------------------------------------------------------------------------

/**
 * A commit paired with its own CID.
 */
export interface CommitWithCid {
    cid: string;
    commit: PerspectiveCommitNode;
}

/**
 * Walk the DAG from one or more heads back through ALL ancestors, stopping at
 * (and excluding) any CID in `stopCids`. Handles multi-parent (merge) nodes:
 * every parent is followed, and each commit is visited at most once (deduped
 * by CID).
 *
 * Returns commits keyed by CID, in reverse-topological order (heads first,
 * genesis last) — the order a caller would reverse to fold from genesis.
 */
export async function walkDag(
    apiUrl: string,
    heads: string[],
    stopCids: Iterable<string> = [],
    maxNodes: number = 100_000,
): Promise<CommitWithCid[]> {
    const stop = new Set<string>(stopCids);
    const visited = new Set<string>();
    const out: CommitWithCid[] = [];

    // Deterministic frontier: process CIDs in sorted order so the output order
    // is stable regardless of the order heads were supplied.
    let frontier = [...new Set(heads)].filter((c) => c && !stop.has(c)).sort();

    while (frontier.length > 0 && out.length < maxNodes) {
        const next: string[] = [];
        for (const cid of frontier) {
            if (visited.has(cid) || stop.has(cid)) continue;
            visited.add(cid);

            // A head or parent block may be transiently unavailable (a peer's
            // head that hasn't propagated its blocks yet). Skip it rather than
            // aborting the whole walk — the OR-Set fold converges on whatever
            // history IS reachable, and the missing part is picked up on a
            // later sync once the blocks arrive.
            let commit: PerspectiveCommitNode;
            try {
                commit = await fetchCommit(apiUrl, cid);
            } catch (err) {
                console.log(`[ipfs-link-language] walkDag: skipping unfetchable commit ${cid}: ${err}`);
                continue;
            }
            out.push({ cid, commit });

            for (const parent of getParentCids(commit)) {
                if (!visited.has(parent) && !stop.has(parent)) {
                    next.push(parent);
                }
            }
        }
        frontier = [...new Set(next)].sort();
    }

    return out;
}

/**
 * Backwards-compatible single-head walk. Walks from `startCid` through all
 * ancestors (multi-parent aware), stopping before `stopCid`.
 *
 * Returns bare commit nodes (no CIDs) in reverse-topological order, preserving
 * the historical return shape used by `collectDiffFromCommits`.
 */
export async function walkCommitChain(
    apiUrl: string,
    startCid: string,
    stopCid: string | null = null,
    maxDepth: number = 100_000,
): Promise<PerspectiveCommitNode[]> {
    const withCids = await walkDag(apiUrl, [startCid], stopCid ? [stopCid] : [], maxDepth);
    return withCids.map((x) => x.commit);
}

// ---------------------------------------------------------------------------
// OR-Set fold — the authoritative materialiser
// ---------------------------------------------------------------------------

/**
 * The result of folding the DAG: the live link set plus the observed
 * add / remove hashes (the OR-Set state).
 */
export interface FoldResult {
    /** Live links (added, not tombstoned), keyed by link content hash. */
    links: Map<string, LinkExpression>;
    /** Every link hash ever added. */
    added: Set<string>;
    /** Every link hash ever removed (tombstones). */
    removed: Set<string>;
}

/**
 * Fold a set of commits into an OR-Set of links, keyed by link content hash.
 *
 * Semantics (observed-remove set over immutable content-addressed elements):
 *  - add:    insert the link hash into `added` and remember the link body.
 *  - remove: insert the link hash into `removed` (a tombstone on the SPECIFIC
 *            observed hash).
 *  - live:   `added \ removed`.
 *
 * This is commutative and idempotent: because every element is identified by
 * its content hash, applying the same commits in any order — and applying the
 * same commit more than once — yields the identical live set. That is what
 * makes concurrent multi-writer merges converge with no coordinator.
 *
 * The input order does not matter; the caller may pass commits in any order.
 */
export function foldCommits(commits: PerspectiveCommitNode[]): FoldResult {
    const links = new Map<string, LinkExpression>();
    const added = new Set<string>();
    const removed = new Set<string>();

    // Pass 1: gather all adds (remember bodies) and all removes.
    for (const commit of commits) {
        for (const node of commit.additions) {
            const h = linkNodeHash(node);
            added.add(h);
            if (!links.has(h)) {
                links.set(h, nodesToLinks([node])[0]);
            }
        }
        for (const node of commit.removals) {
            removed.add(linkNodeHash(node));
        }
    }

    // Pass 2: live set = added minus removed.
    for (const h of removed) {
        links.delete(h);
    }

    return { links, added, removed };
}

/**
 * Convenience: fold commits and return only the live link set as an array.
 */
export function foldCommitsToLinks(commits: PerspectiveCommitNode[]): LinkExpression[] {
    return [...foldCommits(commits).links.values()];
}

/**
 * Fold the entire DAG reachable from `heads` into the live link set.
 */
export async function foldDag(
    apiUrl: string,
    heads: string[],
): Promise<FoldResult> {
    const withCids = await walkDag(apiUrl, heads);
    return foldCommits(withCids.map((x) => x.commit));
}

/**
 * Collect additions and removals from a chain of commits into a PerspectiveDiff
 * that, when applied to the local store, converges it to the DAG's OR-Set live
 * set.
 *
 * The returned diff:
 *  - `additions`: links that are live (added and not tombstoned) in this
 *    commit set.
 *  - `removals`: links that were tombstoned in this commit set (so the local
 *    store deletes them even if it had previously applied the add).
 *
 * This replaces the old naive "concatenate every addition and every removal"
 * behaviour, which could not reconcile a remove against its original add.
 */
export function collectDiffFromCommits(
    commits: PerspectiveCommitNode[],
): PerspectiveDiff {
    const { links, removed } = foldCommits(commits);

    const additions: LinkExpression[] = [...links.values()];

    // Emit removals for every tombstoned hash, so a store that already has the
    // link deletes it. Reconstruct the link body from the removal nodes.
    const removalBodies = new Map<string, LinkExpression>();
    for (const commit of commits) {
        for (const node of commit.removals) {
            const h = linkNodeHash(node);
            if (removed.has(h) && !links.has(h) && !removalBodies.has(h)) {
                removalBodies.set(h, nodesToLinks([node])[0]);
            }
        }
    }

    return { additions, removals: [...removalBodies.values()] };
}
