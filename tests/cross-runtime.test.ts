/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules using mock adapters that
 * simulate an alternative runtime (e.g. WASM).
 *
 * Proves that the core logic has NO hidden dependency on ad4m:host —
 * every external call goes through the injected adapters.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";
import type { SigningAdapter } from "../src/adapters.js";
import { initSigning } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";

// Production modules under test
import * as store from "../src/store.js";
import { linkToNode, nodeToLink, linkContentKey, linksToNodes, nodesToLinks } from "../src/translate.js";
import { dagJsonEncode, dagJsonDecode, dagLink, isDagJsonLink } from "../src/ipld.js";
import { buildCommitNode, buildGenesisCommit, getPreviousCid, isValidCommitNode, commitSize } from "../src/perspective-dag.js";
import { isDuplicate, linkContentHash, linkOriginKey, shouldPublish, isExcludedPredicate } from "../src/translate.js";
import { detectPattern } from "../src/translate.js";
import { buildCIDv1, parseCID, isCID, base58btcEncode, base58btcDecode } from "../src/cid.js";
import { recordPin, removePin, isPinned, listPinnedCids } from "../src/pinning.js";
import { getHeadCid, setHeadCid } from "../src/perspective-dag.js";

// Types
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    put(key: string, value: string): void {
        this.data.set(key, value);
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        if (!prefix) return all;
        return all.filter(k => k.startsWith(prefix));
    }

    _dump(): Map<string, string> {
        return new Map(this.data);
    }

    _clear(): void {
        this.data.clear();
    }
}

class MockTransport implements Transport {
    private responses = new Map<string, TransportResponse>();
    public requests: Array<{ url: string; method: string; body: string }> = [];

    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, body });
        const exact = this.responses.get(url);
        if (exact) return exact;
        return { status: 404, headers: {}, body: "Not found" };
    }
}

class MockSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return "mocksig" + payload.length.toString(16);
    }

    signingKeyId(): string {
        return "mock-key-id";
    }
}

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];

    hash(data: string): string {
        return simpleHash(data);
    }

    emitSignal(data: string): void {
        this.signals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.diffs.push(diff);
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockSigning: MockSigningAdapter;
let mockRuntime: MockRuntime;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockSigning = new MockSigningAdapter();
    mockRuntime = new MockRuntime();

    initRuntime(mockRuntime);
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(mockSigning);
    store.initStore(simpleHash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(() => initAllAdapters());

    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(hash);
        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
    });

    it("indexes by source, target, and predicate", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 1);
        assert.equal(store.queryLinks({ target: "literal://world" }).length, 1);
        assert.equal(store.queryLinks({ predicate: "sioc://content_of" }).length, 1);
    });

    it("returns empty for non-matching queries", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "nonexistent://uri" }).length, 0);
    });

    it("removes links and indexes", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 0);
    });

    it("applies PerspectiveDiff", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ data: { source: "a", target: "b", predicate: "c" } });
        store.putLink(link1);
        store.applyDiff({ additions: [link2], removals: [link1] });
        assert.equal(store.getLink(store.hashLink(link1)), null);
        assert.ok(store.getLink(store.hashLink(link2)));
    });

    it("allLinks returns all links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({ timestamp: "2026-05-03T00:00:00.000Z" }));
        assert.equal(store.allLinks().links.length, 2);
    });

    it("manages revision tracking", () => {
        assert.equal(store.getRevision(), null);
        store.setRevision("bafyRev1");
        assert.equal(store.getRevision(), "bafyRev1");
    });

    it("manages peers", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.setPeer("did:key:z6MkB", { name: "Bob" });
        assert.equal(store.listPeers().length, 2);
        assert.equal(store.getPeerMetadata("did:key:z6MkA")!.name, "Alice");
        store.removePeer("did:key:z6MkA");
        assert.equal(store.listPeers().length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Translation round-trip via mock runtime
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Translation round-trip", () => {
    beforeEach(() => initAllAdapters());

    it("link → node → link is lossless", () => {
        const original = makeLinkExpression();
        const node = linkToNode(original);
        const recovered = nodeToLink(node);

        assert.equal(recovered.data.source, original.data.source);
        assert.equal(recovered.data.target, original.data.target);
        assert.equal(recovered.data.predicate, original.data.predicate);
        assert.equal(recovered.author, original.author);
        assert.equal(recovered.proof.signature, original.proof.signature);
    });

    it("DAG-JSON round-trip preserves link node", () => {
        const original = makeLinkExpression();
        const node = linkToNode(original);
        const json = dagJsonEncode(node);
        const decoded = dagJsonDecode<typeof node>(json);
        const link = nodeToLink(decoded);

        assert.equal(link.data.source, original.data.source);
        assert.equal(link.data.target, original.data.target);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Commit node chain via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Commit node chain", () => {
    beforeEach(() => initAllAdapters());

    it("genesis commit has null previous", () => {
        const node = buildGenesisCommit("did:key:z6MkTest", [linkToNode(makeLinkExpression())]);
        assert.equal(node.previous, null);
        assert.equal(isValidCommitNode(node), true);
    });

    it("subsequent commit links to previous", () => {
        const node = buildCommitNode("did:key:z6MkTest", [], [], "bafyPrev");
        assert.deepEqual(node.previous, { "/": "bafyPrev" });
        assert.equal(getPreviousCid(node), "bafyPrev");
    });

    it("head CID management works through mock storage", () => {
        assert.equal(getHeadCid(), null);
        setHeadCid("bafyHead1");
        assert.equal(getHeadCid(), "bafyHead1");
        setHeadCid("bafyHead2");
        assert.equal(getHeadCid(), "bafyHead2");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Pin management via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Pin management", () => {
    beforeEach(() => initAllAdapters());

    it("records and checks pins", () => {
        assert.equal(isPinned("bafyTest"), false);
        recordPin("bafyTest");
        assert.equal(isPinned("bafyTest"), true);
    });

    it("removes pins", () => {
        recordPin("bafyTest");
        removePin("bafyTest");
        assert.equal(isPinned("bafyTest"), false);
    });

    it("lists pinned CIDs", () => {
        recordPin("bafyA");
        recordPin("bafyB");
        recordPin("bafyC");
        const pinned = listPinnedCids();
        assert.equal(pinned.length, 3);
        assert.ok(pinned.includes("bafyA"));
        assert.ok(pinned.includes("bafyB"));
        assert.ok(pinned.includes("bafyC"));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. CID encoding via pure functions
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: CID encoding", () => {
    it("builds and parses CIDv1", () => {
        const digest = new Uint8Array(32).fill(0x42);
        const cid = buildCIDv1(0x0129, 0x12, digest);
        const parsed = parseCID(cid);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.codec, 0x0129);
        assert.equal(parsed.hashFunction, 0x12);
        assert.deepEqual(parsed.digest, digest);
    });

    it("base58btc round-trips", () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const encoded = base58btcEncode(original);
        const decoded = base58btcDecode(encoded);
        assert.deepEqual(decoded, original);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Full pipeline: link → DAG-JSON → commit → verify
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Full pipeline", () => {
    beforeEach(() => initAllAdapters());

    it("full round-trip: link → DAG-JSON node → commit → extract → link", () => {
        // 1. Create links
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "channel://general", target: "expr://msg-100", predicate: "flux://has_message" },
        });

        // 2. Convert to DAG-JSON nodes
        const nodes = linksToNodes([link1, link2]);
        assert.equal(nodes.length, 2);
        assert.equal(nodes[0].type, "ad4m:LinkExpression");

        // 3. Build a commit
        const commit = buildGenesisCommit("did:key:z6MkTest", nodes, "2026-05-02T12:00:00.000Z");
        assert.equal(commit.additions.length, 2);
        assert.equal(commit.previous, null);

        // 4. DAG-JSON encode the commit
        const encoded = dagJsonEncode(commit);
        assert.ok(encoded.includes("ad4m:PerspectiveCommit"));

        // 5. Decode and extract links
        const decoded = dagJsonDecode<typeof commit>(encoded);
        assert.equal(isValidCommitNode(decoded), true);
        const recoveredLinks = nodesToLinks(decoded.additions);

        // 6. Verify round-trip
        assert.equal(recoveredLinks.length, 2);
        assert.equal(recoveredLinks[0].data.source, link1.data.source);
        assert.equal(recoveredLinks[0].data.target, link1.data.target);
        assert.equal(recoveredLinks[1].data.source, link2.data.source);
        assert.equal(recoveredLinks[1].data.target, link2.data.target);
    });

    it("commit chain preserves ordering", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
            timestamp: "2026-05-02T01:00:00.000Z",
        });

        // Genesis commit
        const genesis = buildGenesisCommit("did:key:z6MkTest", linksToNodes([link1]));
        const genesisJson = dagJsonEncode(genesis);

        // Second commit
        const commit2 = buildCommitNode(
            "did:key:z6MkTest",
            linksToNodes([link2]),
            [],
            "bafyGenesis",
        );
        const commit2Json = dagJsonEncode(commit2);

        // Verify chain
        const decodedGenesis = dagJsonDecode<typeof genesis>(genesisJson);
        const decodedCommit2 = dagJsonDecode<typeof commit2>(commit2Json);

        assert.equal(getPreviousCid(decodedGenesis), null);
        assert.equal(getPreviousCid(decodedCommit2), "bafyGenesis");

        // Extract all links
        const allLinks = [
            ...nodesToLinks(decodedGenesis.additions),
            ...nodesToLinks(decodedCommit2.additions),
        ];
        assert.equal(allLinks.length, 2);
    });

    it("SDNA pattern detection works end-to-end", () => {
        const chatLink = makeLinkExpression({
            data: {
                source: "channel://main",
                target: "expr://msg-42",
                predicate: "flux://has_message",
            },
        });

        const pattern = detectPattern(chatLink, ["flux://has_message"]);
        assert.equal(pattern.type, "chat-message");
        assert.equal(pattern.channelUri, "channel://main");
        assert.equal(pattern.contentUri, "expr://msg-42");

        // Store and retrieve through the full pipeline
        const hash = store.putLink(chatLink);
        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        const retrievedPattern = detectPattern(retrieved!, ["flux://has_message"]);
        assert.equal(retrievedPattern.type, "chat-message");
    });

    it("dual-language origin tracking works through store", () => {
        const link = makeLinkExpression();
        const hash = store.hashLink(link);

        // New link — no origin tracked
        assert.equal(shouldPublish(hash, k => mockStorage.get(k)), true);

        // Mark as from IPFS
        mockStorage.put(linkOriginKey(hash), "ipfs");
        assert.equal(shouldPublish(hash, k => mockStorage.get(k)), false);

        // Mark as dual
        mockStorage.put(linkOriginKey(hash), "dual");
        assert.equal(shouldPublish(hash, k => mockStorage.get(k)), true);
    });
});
