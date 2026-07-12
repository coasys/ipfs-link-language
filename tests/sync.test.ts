/**
 * Tests for sync orchestration — per-agent IPNS head discovery, multi-parent
 * DAG traversal, OR-Set convergence, and deterministic merge.
 *
 * Uses mock adapters to simulate IPFS node interactions. The IPFS API surface
 * (dag/get, name/resolve) is deterministic and content-addressed, so the DAG
 * walk + fold logic is fully exercisable in-process.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";
import type { SigningAdapter } from "../src/adapters.js";
import { initSigning } from "../src/adapters.js";
import * as store from "../src/store.js";
import {
    syncFromIPNS,
    syncFromCID,
    fullSync,
    discoverPeerHead,
    converge,
} from "../src/sync.js";
import {
    getHeadCid,
    setHeadCid,
    setPeerHead,
    currentHeads,
    currentRevisionHash,
    buildGenesisCommit,
    buildCommitNode,
} from "../src/perspective-dag.js";
import { linkToNode } from "../src/translate.js";
import { dagJsonEncode } from "../src/ipld.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock Adapters
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

/**
 * A mock IPFS transport that serves a content-addressed block store: dag/get
 * looks up a node by the CID in the `arg` query param; name/resolve returns a
 * configured IPNS → CID mapping.
 */
class MockIpfs implements Transport {
    blocks = new Map<string, string>();   // cid → dag-json body
    ipns = new Map<string, string>();      // ipnsName → cid

    putBlock(cid: string, node: unknown): void {
        this.blocks.set(cid, dagJsonEncode(node));
    }
    setIpns(name: string, cid: string): void {
        this.ipns.set(name, cid);
    }

    /** Content-address a dag-json body deterministically (test CID). */
    private cidOf(body: string): string {
        let h = 0;
        for (let i = 0; i < body.length; i++) { h = ((h << 5) - h + body.charCodeAt(i)) | 0; }
        return `bafytest${Math.abs(h).toString(16)}`;
    }

    /** Extract the JSON payload embedded in a Kubo multipart dag/put body. */
    private extractMultipartJson(body: string): string {
        const start = body.indexOf("{");
        const end = body.lastIndexOf("}");
        if (start >= 0 && end >= start) return body.slice(start, end + 1);
        return body;
    }

    async fetch(url: string, _m: string, _h: Record<string, string>, reqBody: string): Promise<TransportResponse> {
        const u = new URL(url);
        if (u.pathname.endsWith("/dag/put")) {
            const json = this.extractMultipartJson(reqBody);
            const cid = this.cidOf(json);
            this.blocks.set(cid, json);
            return { status: 200, headers: {}, body: JSON.stringify({ Cid: { "/": cid } }) };
        }
        if (u.pathname.endsWith("/dag/get")) {
            const cid = u.searchParams.get("arg") || "";
            const body = this.blocks.get(cid);
            if (body == null) return { status: 404, headers: {}, body: "Not found" };
            return { status: 200, headers: {}, body };
        }
        if (u.pathname.endsWith("/name/resolve")) {
            const name = u.searchParams.get("arg") || "";
            const cid = this.ipns.get(name);
            if (cid == null) return { status: 500, headers: {}, body: "could not resolve name" };
            return { status: 200, headers: {}, body: JSON.stringify({ Path: `/ipfs/${cid}` }) };
        }
        return { status: 404, headers: {}, body: "Not found" };
    }
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string {
        // Deterministic content hash — fine for tests (real runtime uses SHA-256).
        let h = 0;
        for (let i = 0; i < data.length; i++) { h = ((h << 5) - h + data.charCodeAt(i)) | 0; }
        return `Qm${Math.abs(h).toString(16)}`;
    }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(_diff: unknown): void {}
}

class MockSigning implements SigningAdapter {
    signStringHex(_payload: string): string { return "mocksig"; }
    signingKeyId(): string { return "mock-key"; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API = "http://localhost:5001";
const IPNS_NAME = "k51qzi5uqu5dltest";

function makeLink(index: number): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: `2026-05-02T0${index}:00:00.000Z`,
        data: {
            source: `channel://chan-${index}`,
            target: `expr://msg-${index}`,
            predicate: "flux://has_message",
        },
        proof: { signature: "sig", key: "key" },
    };
}

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
// discoverPeerHead
// ---------------------------------------------------------------------------

describe("discoverPeerHead", () => {
    beforeEach(() => initAll());

    it("returns null when IPNS resolution fails", async () => {
        const cid = await discoverPeerHead(API, IPNS_NAME);
        assert.equal(cid, null);
    });

    it("resolves a peer IPNS name and records its head", async () => {
        ipfs.setIpns(IPNS_NAME, "bafyPeerHead");
        const cid = await discoverPeerHead(API, IPNS_NAME);
        assert.equal(cid, "bafyPeerHead");
        assert.ok(currentHeads().includes("bafyPeerHead"));
    });
});

// ---------------------------------------------------------------------------
// syncFromIPNS
// ---------------------------------------------------------------------------

describe("syncFromIPNS", () => {
    beforeEach(() => initAll());

    it("returns empty diff when IPNS resolution fails", async () => {
        const diff = await syncFromIPNS(API, IPNS_NAME);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("returns no new links when already at the resolved head", async () => {
        // Genesis on the store + head, and IPNS points at that same genesis.
        const genesis = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLink(1))]);
        const genesisCid = "bafyGenesis";
        ipfs.putBlock(genesisCid, genesis);
        ipfs.setIpns(IPNS_NAME, genesisCid);

        // Pre-apply genesis + adopt as head.
        store.applyDiff({ additions: [makeLink(1)], removals: [] });
        setHeadCid(genesisCid);

        const diff = await syncFromIPNS(API, IPNS_NAME);
        // Fold is idempotent: the single live link is re-materialised but no
        // NEW state appears; the store still holds exactly one link.
        assert.equal(store.allLinks().links.length, 1);
        assert.equal(diff.removals.length, 0);
        assert.equal(getHeadCid(), genesisCid);
    });

    it("syncs new commits from a peer IPNS head", async () => {
        const genesis = buildGenesisCommit(
            "did:key:z6MkTest",
            [linkToNode(makeLink(1)), linkToNode(makeLink(2))],
            "2026-05-02T00:00:00.000Z",
        );
        const genesisCid = "bafyGenesisCommit";
        ipfs.putBlock(genesisCid, genesis);
        ipfs.setIpns(IPNS_NAME, genesisCid);

        const diff = await syncFromIPNS(API, IPNS_NAME);
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);
        assert.equal(getHeadCid(), genesisCid);
        assert.equal(store.allLinks().links.length, 2);
    });
});

// ---------------------------------------------------------------------------
// syncFromCID
// ---------------------------------------------------------------------------

describe("syncFromCID", () => {
    beforeEach(() => initAll());

    it("syncs from a known CID and adopts it as head", async () => {
        const commit = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLink(1))]);
        ipfs.putBlock("bafyNewCommit", commit);

        const diff = await syncFromCID(API, "bafyNewCommit");
        assert.equal(diff.additions.length, 1);
        assert.equal(getHeadCid(), "bafyNewCommit");
    });

    it("is idempotent when the CID is already the head", async () => {
        const commit = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLink(1))]);
        ipfs.putBlock("bafyTarget", commit);
        store.applyDiff({ additions: [makeLink(1)], removals: [] });
        setHeadCid("bafyTarget");

        await syncFromCID(API, "bafyTarget");
        assert.equal(store.allLinks().links.length, 1);
        assert.equal(getHeadCid(), "bafyTarget");
    });
});

// ---------------------------------------------------------------------------
// fullSync
// ---------------------------------------------------------------------------

describe("fullSync", () => {
    beforeEach(() => initAll());

    it("walks the entire DAG from a head", async () => {
        // genesis <- commit2 (linear chain)
        const genesis = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLink(1))]);
        const genesisCid = "bafyGen";
        const commit2 = buildCommitNode("did:key:z6MkTest", [linkToNode(makeLink(2))], [], [genesisCid]);
        const commit2Cid = "bafyC2";
        ipfs.putBlock(genesisCid, genesis);
        ipfs.putBlock(commit2Cid, commit2);

        const diff = await fullSync(API, commit2Cid);
        assert.equal(diff.additions.length, 2);
        assert.equal(getHeadCid(), commit2Cid);
        assert.equal(store.allLinks().links.length, 2);
    });
});

// ---------------------------------------------------------------------------
// converge — the head frontier + revision
// ---------------------------------------------------------------------------

describe("converge", () => {
    beforeEach(() => initAll());

    it("returns an empty revision when there are no heads", async () => {
        const res = await converge(API);
        assert.equal(res.revision, "");
        assert.equal(res.heads.length, 0);
    });

    it("revision is the single head CID when there is one head", async () => {
        const genesis = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLink(1))]);
        ipfs.putBlock("bafyOnlyHead", genesis);
        setHeadCid("bafyOnlyHead");

        const res = await converge(API);
        assert.equal(res.revision, "bafyOnlyHead");
        assert.deepEqual(res.heads, ["bafyOnlyHead"]);
        // currentRevisionHash agrees.
        assert.equal(currentRevisionHash(), "bafyOnlyHead");
    });

    it("merges two divergent heads into a single merge CID head", async () => {
        // Shared genesis; two concurrent children A and B off it.
        const genesis = buildGenesisCommit("did:a", [linkToNode(makeLink(1))]);
        const gCid = "bafyG";
        const branchA = buildCommitNode("did:a", [linkToNode(makeLink(2))], [], [gCid]);
        const branchB = buildCommitNode("did:b", [linkToNode(makeLink(3))], [], [gCid]);
        const aCid = "bafyA";
        const bCid = "bafyB";
        ipfs.putBlock(gCid, genesis);
        ipfs.putBlock(aCid, branchA);
        ipfs.putBlock(bCid, branchB);

        // Our own head is A; a peer's head is B.
        setHeadCid(aCid);
        setPeerHead("did:b", bCid);

        const putBlocks: string[] = [];
        const res = await converge(API, {
            mergeAuthor: "did:a",
            publishHead: async (cid) => { putBlocks.push(cid); },
        });

        // A merge commit was created and published; it is now the sole head.
        assert.ok(res.mergeCid, "expected a merge commit");
        assert.deepEqual(res.heads, [res.mergeCid]);
        assert.equal(putBlocks.length, 1);
        assert.equal(putBlocks[0], res.mergeCid);

        // The merged store holds all three links (OR-Set union).
        assert.equal(store.allLinks().links.length, 3);
    });
});
