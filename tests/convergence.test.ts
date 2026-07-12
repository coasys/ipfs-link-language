/**
 * Acceptance-criteria regression tests for genuine perspective-sync
 * convergence (SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE §5).
 *
 * These would have caught the pre-rework fake, where:
 *   - `previous` was a single parent (no merge commits),
 *   - the DAG fold naively concatenated adds/removals (no OR-Set keyed by
 *     link hash → removals could not reconcile against their original add),
 *   - `currentRevision` returned the last-resolved IPNS CID (a single-writer
 *     cursor that clobbered on concurrent publish), not a head-frontier hash.
 *
 * Everything here is content-addressed and deterministic, so it runs fully
 * in-process — no live IPFS node required.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter, RuntimeAdapter, Transport, TransportResponse, SigningAdapter } from "../src/adapters.js";
import { initStorage, initRuntime, initTransport, initSigning } from "../src/adapters.js";
import * as store from "../src/store.js";
import {
    buildGenesisCommit,
    buildCommitNode,
    buildMergeCommit,
    getParentCids,
    linkNodeHash,
    foldCommits,
    foldCommitsToLinks,
    collectDiffFromCommits,
    revisionFromHeads,
    walkDag,
    type PerspectiveCommitNode,
} from "../src/perspective-dag.js";
import { linkToNode } from "../src/translate.js";
import { dagJsonEncode } from "../src/ipld.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string {
        // SHA-256-shaped deterministic hash (real runtime uses SHA-256 → CIDv1).
        let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
        for (let i = 0; i < data.length; i++) {
            h1 = Math.imul(h1 ^ data.charCodeAt(i), 0x01000193);
            h2 = Math.imul(h2 + data.charCodeAt(i), 0x85ebca77);
        }
        return `Qm${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
    }
    emitSignal(): void {}
    emitPerspectiveDiff(): void {}
}

class MockSigning implements SigningAdapter {
    signStringHex(): string { return "sig"; }
    signingKeyId(): string { return "key"; }
}

/** A content-addressed block store fronting dag/get + dag/put. */
class MockIpfs implements Transport {
    blocks = new Map<string, string>();
    put(node: unknown): string {
        const body = dagJsonEncode(node);
        const cid = this.cidOf(body);
        this.blocks.set(cid, body);
        return cid;
    }
    private cidOf(body: string): string {
        let h = 0;
        for (let i = 0; i < body.length; i++) { h = ((h << 5) - h + body.charCodeAt(i)) | 0; }
        return `bafy${Math.abs(h).toString(16)}`;
    }
    async fetch(url: string, _m: string, _h: Record<string, string>, _b: string): Promise<TransportResponse> {
        const u = new URL(url);
        if (u.pathname.endsWith("/dag/get")) {
            const cid = u.searchParams.get("arg") || "";
            const body = this.blocks.get(cid);
            return body == null
                ? { status: 404, headers: {}, body: "Not found" }
                : { status: 200, headers: {}, body };
        }
        return { status: 404, headers: {}, body: "Not found" };
    }
}

const API = "http://localhost:5001";
let ipfs: MockIpfs;

function initAll(): void {
    initRuntime(new MockRuntime());
    initStorage(new MockStorage());
    ipfs = new MockIpfs();
    initTransport(ipfs);
    initSigning(new MockSigning());
    store.initStore(new MockRuntime().hash);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function link(source: string, target: string, predicate = "flux://has_message", author = "did:key:z6MkA", timestamp = "2026-05-02T00:00:00.000Z"): LinkExpression {
    return { author, timestamp, data: { source, target, predicate }, proof: { signature: "sig", key: "key" } };
}

// ---------------------------------------------------------------------------
// §5.1 — DAG is authoritative: folding from genesis reproduces the link set
// ---------------------------------------------------------------------------

describe("§5.1 DAG fold reproduces the link set (multi-parent)", () => {
    beforeEach(() => initAll());

    it("folds a linear chain from genesis into the live link set", () => {
        const l1 = link("a", "1");
        const l2 = link("a", "2");
        const l3 = link("a", "3");
        const genesis = buildGenesisCommit("did:a", [linkToNode(l1)]);
        const c2 = buildCommitNode("did:a", [linkToNode(l2)], [], ["cidGenesis"]);
        const c3 = buildCommitNode("did:a", [linkToNode(l3)], [], ["cidC2"]);

        const links = foldCommitsToLinks([genesis, c2, c3]);
        assert.equal(links.length, 3);
        const targets = links.map(l => l.data.target).sort();
        assert.deepEqual(targets, ["1", "2", "3"]);
    });

    it("folds a diamond (multi-parent merge) without double-counting shared history", async () => {
        // genesis <- A, genesis <- B, merge(A,B). Genesis link must appear once.
        const lg = link("a", "g");
        const la = link("a", "A");
        const lb = link("a", "B");
        const gCid = ipfs.put(buildGenesisCommit("did:a", [linkToNode(lg)]));
        const aCid = ipfs.put(buildCommitNode("did:a", [linkToNode(la)], [], [gCid]));
        const bCid = ipfs.put(buildCommitNode("did:b", [linkToNode(lb)], [], [gCid]));
        const mCid = ipfs.put(buildMergeCommit("did:a", [aCid, bCid]));

        const walked = await walkDag(API, [mCid]);
        // 4 distinct commits: merge, A, B, genesis (genesis visited ONCE).
        assert.equal(walked.length, 4);

        const links = foldCommitsToLinks(walked.map(w => w.commit));
        const targets = links.map(l => l.data.target).sort();
        assert.deepEqual(targets, ["A", "B", "g"]);
    });
});

// ---------------------------------------------------------------------------
// §5.3 — Removal convergence (OR-Set keyed by original link hash)
// ---------------------------------------------------------------------------

describe("§5.3 removal convergence", () => {
    beforeEach(() => initAll());

    it("A adds L, B removes the SAME hash → L absent after merge", () => {
        const L = link("chan", "msg");
        // The removal must carry the ORIGINAL link so its hash matches the add.
        const addNode = linkToNode(L);
        const removeNode = linkToNode(L);
        assert.equal(linkNodeHash(addNode), linkNodeHash(removeNode), "add/remove must hash identically");

        const commitA = buildGenesisCommit("did:a", [addNode]);
        const commitB = buildCommitNode("did:b", [], [removeNode], ["cidA"]);

        const { links, added, removed } = foldCommits([commitA, commitB]);
        assert.ok(added.has(linkNodeHash(addNode)));
        assert.ok(removed.has(linkNodeHash(removeNode)));
        assert.equal(links.size, 0, "tombstoned link must be absent from live set");
    });

    it("the store converges to absent on both replicas after applying the merge diff", () => {
        const L = link("chan", "msg");
        // Replica that had the add applied.
        store.applyDiff({ additions: [L], removals: [] });
        assert.equal(store.allLinks().links.length, 1);

        const commitA = buildGenesisCommit("did:a", [linkToNode(L)]);
        const commitB = buildCommitNode("did:b", [], [linkToNode(L)], ["cidA"]);
        const diff = collectDiffFromCommits([commitA, commitB]);

        // The derived diff must tombstone the link so an already-applied store deletes it.
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 1);

        store.applyDiff(diff);
        assert.equal(store.allLinks().links.length, 0, "link removed after convergence");
    });

    it("a remove for a never-seen add still tombstones (order-independent)", () => {
        const L = link("chan", "msg");
        const commitRemoveFirst = buildGenesisCommit("did:b", []);
        const removeCommit = buildCommitNode("did:b", [], [linkToNode(L)], ["cidX"]);
        const addCommit = buildCommitNode("did:a", [linkToNode(L)], [], ["cidX"]);

        // Apply remove "before" add in fold order — OR-Set still tombstones.
        const r1 = foldCommits([commitRemoveFirst, removeCommit, addCommit]);
        const r2 = foldCommits([addCommit, removeCommit, commitRemoveFirst]);
        assert.equal(r1.links.size, 0);
        assert.equal(r2.links.size, 0);
    });
});

// ---------------------------------------------------------------------------
// §5.4 — Merge is order-independent (same revision + link set either order)
// ---------------------------------------------------------------------------

describe("§5.4 merge is order-independent", () => {
    beforeEach(() => initAll());

    it("folding {d1,d2} in either order yields the same live link set", () => {
        const l1 = link("a", "1");
        const l2 = link("b", "2");
        const d1 = buildCommitNode("did:a", [linkToNode(l1)], [], ["g"]);
        const d2 = buildCommitNode("did:b", [linkToNode(l2)], [], ["g"]);

        const forward = foldCommitsToLinks([d1, d2]).map(l => linkNodeHash(linkToNode(l))).sort();
        const backward = foldCommitsToLinks([d2, d1]).map(l => linkNodeHash(linkToNode(l))).sort();
        assert.deepEqual(forward, backward);
    });

    it("a merge commit's parents are deterministic regardless of head discovery order", () => {
        const m1 = buildMergeCommit("did:a", ["bafyB", "bafyA"]);
        const m2 = buildMergeCommit("did:a", ["bafyA", "bafyB"]);
        // Same parents in the same (sorted) order → identical DAG-JSON → same CID.
        assert.equal(dagJsonEncode(m1), dagJsonEncode(m2));
        assert.deepEqual(getParentCids(m1), getParentCids(m2));
    });

    it("two divergent heads merge to the same merge CID regardless of order", () => {
        const la = link("a", "A");
        const lb = link("b", "B");
        const aCid = ipfs.put(buildCommitNode("did:a", [linkToNode(la)], [], ["g"]));
        const bCid = ipfs.put(buildCommitNode("did:b", [linkToNode(lb)], [], ["g"]));

        const mergeAB = ipfs.put(buildMergeCommit("did:x", [aCid, bCid]));
        const mergeBA = ipfs.put(buildMergeCommit("did:x", [bCid, aCid]));
        assert.equal(mergeAB, mergeBA, "merge CID must be order-independent");
    });
});

// ---------------------------------------------------------------------------
// §5 (currentRevision) — content hash of the head frontier, never a cursor
// ---------------------------------------------------------------------------

describe("currentRevision is a content hash of the head frontier", () => {
    beforeEach(() => initAll());

    it("empty frontier → empty string", () => {
        assert.equal(revisionFromHeads([]), "");
    });

    it("single head → that CID (already a content hash)", () => {
        assert.equal(revisionFromHeads(["bafyOnlyHead"]), "bafyOnlyHead");
    });

    it("multiple heads → a deterministic digest, order-independent", () => {
        const r1 = revisionFromHeads(["bafyA", "bafyB", "bafyC"]);
        const r2 = revisionFromHeads(["bafyC", "bafyA", "bafyB"]);
        assert.equal(r1, r2);
        // Not equal to any single head; is a hash (mock prefixes Qm).
        assert.notEqual(r1, "bafyA");
        assert.ok(r1.startsWith("Qm"));
    });

    it("the digest changes deterministically when the head set changes", () => {
        const r1 = revisionFromHeads(["bafyA", "bafyB"]);
        const r2 = revisionFromHeads(["bafyA", "bafyC"]);
        assert.notEqual(r1, r2);
        // Stable across recomputation for the same frontier (restart-stable).
        assert.equal(revisionFromHeads(["bafyA", "bafyB"]), r1);
    });

    it("is never a timestamp or sequence — dedupes + sorts its inputs", () => {
        // Duplicate + unsorted input yields the same result as clean input.
        assert.equal(
            revisionFromHeads(["bafyB", "bafyA", "bafyB"]),
            revisionFromHeads(["bafyA", "bafyB"]),
        );
    });
});

// ---------------------------------------------------------------------------
// Idempotence — folding the same commit twice is a no-op
// ---------------------------------------------------------------------------

describe("OR-Set fold is idempotent", () => {
    beforeEach(() => initAll());

    it("applying the same commit set twice yields the identical live set", () => {
        const l1 = link("a", "1");
        const l2 = link("a", "2");
        const commits: PerspectiveCommitNode[] = [
            buildGenesisCommit("did:a", [linkToNode(l1)]),
            buildCommitNode("did:a", [linkToNode(l2)], [], ["g"]),
        ];
        const once = foldCommits(commits);
        const twice = foldCommits([...commits, ...commits]);
        assert.deepEqual([...once.links.keys()].sort(), [...twice.links.keys()].sort());
        assert.equal(twice.links.size, 2);
    });
});
