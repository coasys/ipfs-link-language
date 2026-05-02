/**
 * Tests for sync — IPNS resolution and DAG traversal.
 * Uses mock adapters to simulate IPFS node interactions.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";
import * as store from "../src/store.js";
import { syncFromIPNS, syncFromCID, fullSync } from "../src/sync.js";
import { getHeadCid, setHeadCid } from "../src/perspective-dag.js";
import { buildCommitNode, buildGenesisCommit } from "../src/perspective-dag.pure.js";
import { linkToNode } from "../src/translate.pure.js";
import { dagJsonEncode } from "../src/ipld.pure.js";
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

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }
    async fetch(url: string, _method: string, _headers: Record<string, string>, _body: string): Promise<TransportResponse> {
        // Try exact match first
        const exact = this.responses.get(url);
        if (exact) return exact;
        // Try prefix match for parameterized URLs
        for (const [key, resp] of this.responses.entries()) {
            if (url.startsWith(key) || url.includes(key.replace(/^.*\/api/, "/api"))) {
                return resp;
            }
        }
        return { status: 404, headers: {}, body: "Not found" };
    }
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string {
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

let mockTransport: MockTransport;

function initAll(): void {
    initRuntime(new MockRuntime());
    initStorage(new MockStorage());
    mockTransport = new MockTransport();
    initTransport(mockTransport);
    initSigning(new MockSigning());
    store.initStore(new MockRuntime().hash);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncFromIPNS", () => {
    beforeEach(() => initAll());

    it("returns empty diff when IPNS resolution fails", async () => {
        // No response configured → 404
        const diff = await syncFromIPNS(API, IPNS_NAME);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("returns empty diff when already at latest", async () => {
        setHeadCid("bafyExistingHead");

        // IPNS resolves to same CID
        mockTransport.addResponse(
            `${API}/api/v0/name/resolve`,
            { status: 200, headers: {}, body: JSON.stringify({ Path: "/ipfs/bafyExistingHead" }) },
        );

        const diff = await syncFromIPNS(API, IPNS_NAME);
        assert.equal(diff.additions.length, 0);
    });

    it("syncs new commits from IPNS", async () => {
        // Create a genesis commit
        const link1 = makeLink(1);
        const link2 = makeLink(2);
        const genesisNode = buildGenesisCommit(
            "did:key:z6MkTest",
            [linkToNode(link1), linkToNode(link2)],
            "2026-05-02T00:00:00.000Z",
        );

        const genesisCid = "bafyGenesisCommit";

        // IPNS resolves to genesis
        mockTransport.addResponse(
            `${API}/api/v0/name/resolve`,
            { status: 200, headers: {}, body: JSON.stringify({ Path: `/ipfs/${genesisCid}` }) },
        );

        // dag/get returns the genesis commit
        mockTransport.addResponse(
            `${API}/api/v0/dag/get`,
            { status: 200, headers: {}, body: dagJsonEncode(genesisNode) },
        );

        const diff = await syncFromIPNS(API, IPNS_NAME);
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);

        // Head should be updated
        assert.equal(getHeadCid(), genesisCid);

        // Links should be in the store
        const allLinks = store.allLinks();
        assert.equal(allLinks.links.length, 2);
    });
});

describe("syncFromCID", () => {
    beforeEach(() => initAll());

    it("returns empty diff when already at target", async () => {
        setHeadCid("bafyTarget");
        const diff = await syncFromCID(API, "bafyTarget");
        assert.equal(diff.additions.length, 0);
    });

    it("syncs from a known CID", async () => {
        const link = makeLink(1);
        const commit = buildGenesisCommit(
            "did:key:z6MkTest",
            [linkToNode(link)],
        );

        mockTransport.addResponse(
            `${API}/api/v0/dag/get`,
            { status: 200, headers: {}, body: dagJsonEncode(commit) },
        );

        const diff = await syncFromCID(API, "bafyNewCommit");
        assert.equal(diff.additions.length, 1);
        assert.equal(getHeadCid(), "bafyNewCommit");
    });
});

describe("fullSync", () => {
    beforeEach(() => initAll());

    it("walks entire DAG from root", async () => {
        const link = makeLink(1);
        const commit = buildGenesisCommit(
            "did:key:z6MkTest",
            [linkToNode(link)],
        );

        mockTransport.addResponse(
            `${API}/api/v0/dag/get`,
            { status: 200, headers: {}, body: dagJsonEncode(commit) },
        );

        const diff = await fullSync(API, "bafyRoot");
        assert.equal(diff.additions.length, 1);
        assert.equal(getHeadCid(), "bafyRoot");
    });
});
