/**
 * Tests for IPFS PubSub telepresence (pure + impure modules).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Pure imports
import {
    encodeTopicMultibase,
    presenceTopic,
    signalTopic,
    broadcastTopic,
    buildPresenceMessage,
    buildSignalMessage,
    buildBroadcastMessage,
    buildPubsubPublishBody,
    pubsubPubUrl,
    pubsubPeersUrl,
    pubsubLsUrl,
    parsePubsubPeersResponse,
    parsePubsubLsResponse,
    filterOnlineAgents,
    mergePresenceRecord,
    presenceStorageKey,
    peerMapStorageKey,
    presenceStoragePrefix,
    peerMapStoragePrefix,
    signalCallbackKey,
    PRESENCE_TTL_MS,
} from "../src/pubsub.js";
import type { PresenceRecord, PubSubMessage } from "../src/pubsub.js";

// Impure imports (need adapter setup)
import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/adapters.js";
import { initTransport } from "../src/adapters.js";

import {
    publishPresence,
    queryOnlineAgents,
    sendSignal,
    sendBroadcast,
    registerSignalCallback,
    getSignalCallback,
    deliverSignal,
    clearSignalCallback,
    storePeerMapping,
    lookupPeerDid,
    storePresenceRecord,
} from "../src/pubsub.js";

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
    public requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

    addResponse(urlPattern: string, response: TransportResponse): void {
        this.responses.set(urlPattern, response);
    }

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });

        // Check for exact match first
        const exact = this.responses.get(url);
        if (exact) return exact;

        // Check for prefix match
        for (const [pattern, resp] of this.responses) {
            if (url.startsWith(pattern) || url.includes(pattern)) {
                return resp;
            }
        }

        return { status: 200, headers: {}, body: "{}" };
    }

    _clear(): void {
        this.responses.clear();
        this.requests = [];
    }
}

const API = "http://localhost:5001";
const NH_URL = "QmNeighbourhoodTest123";
const AGENT_DID = "did:key:z6MkTestAgent1";
const REMOTE_DID = "did:key:z6MkTestAgent2";

// ===========================================================================
// PURE FUNCTION TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// Topic multibase encoding
// ---------------------------------------------------------------------------

describe("encodeTopicMultibase", () => {
    it("encodes simple topic with u prefix", () => {
        const encoded = encodeTopicMultibase("test-topic");
        assert.equal(encoded, "udGVzdC10b3BpYw");
    });

    it("starts with u prefix", () => {
        const encoded = encodeTopicMultibase("anything");
        assert.ok(encoded.startsWith("u"));
    });

    it("produces base64url characters only (no +, /, =)", () => {
        // Use a string that would produce + and / in standard base64
        const encoded = encodeTopicMultibase("subjects?q=test&foo=bar>>><<<");
        assert.ok(!encoded.includes("+"), "should not contain +");
        assert.ok(!encoded.includes("/"), "should not contain /");
        assert.ok(!encoded.includes("="), "should not contain =");
    });

    it("handles empty string", () => {
        const encoded = encodeTopicMultibase("");
        assert.equal(encoded, "u");
    });

    it("handles unicode characters", () => {
        const encoded = encodeTopicMultibase("hello/wörld");
        assert.ok(encoded.startsWith("u"));
        assert.ok(encoded.length > 1);
    });

    it("encodes presence topic correctly", () => {
        const topic = "ad4m/QmTest/presence";
        const encoded = encodeTopicMultibase(topic);
        assert.ok(encoded.startsWith("u"));
        // Verify roundtrip: decode the base64url back
        const b64 = encoded.slice(1).replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
        const decoded = atob(padded);
        assert.equal(decoded, topic);
    });
});

// ---------------------------------------------------------------------------
// Topic builders
// ---------------------------------------------------------------------------

describe("presenceTopic", () => {
    it("builds correct presence topic", () => {
        assert.equal(presenceTopic("QmTest"), "ad4m/QmTest/presence");
    });
});

describe("signalTopic", () => {
    it("builds correct signal topic with target DID", () => {
        assert.equal(
            signalTopic("QmTest", "did:key:z6Mk1"),
            "ad4m/QmTest/signal/did:key:z6Mk1",
        );
    });
});

describe("broadcastTopic", () => {
    it("builds correct broadcast topic", () => {
        assert.equal(broadcastTopic("QmTest"), "ad4m/QmTest/broadcast");
    });
});

// ---------------------------------------------------------------------------
// Message format construction
// ---------------------------------------------------------------------------

describe("buildPresenceMessage", () => {
    it("builds presence message with correct fields", () => {
        const msg = buildPresenceMessage("did:key:z6Mk1", { online: true }, 1000);
        assert.equal(msg.type, "presence");
        assert.equal(msg.did, "did:key:z6Mk1");
        assert.deepEqual(msg.status, { online: true });
        assert.equal(msg.timestamp, 1000);
    });
});

describe("buildSignalMessage", () => {
    it("builds signal message with correct fields", () => {
        const msg = buildSignalMessage("did:key:z6Mk1", { action: "ping" }, 2000);
        assert.equal(msg.type, "signal");
        assert.equal(msg.from, "did:key:z6Mk1");
        assert.deepEqual(msg.payload, { action: "ping" });
        assert.equal(msg.timestamp, 2000);
    });
});

describe("buildBroadcastMessage", () => {
    it("builds broadcast message with correct fields", () => {
        const msg = buildBroadcastMessage("did:key:z6Mk1", "hello all", 3000);
        assert.equal(msg.type, "broadcast");
        assert.equal(msg.from, "did:key:z6Mk1");
        assert.equal(msg.payload, "hello all");
        assert.equal(msg.timestamp, 3000);
    });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe("pubsubPubUrl", () => {
    it("builds correct pub URL", () => {
        const url = pubsubPubUrl(API, "udGVzdA");
        assert.equal(url, "http://localhost:5001/api/v0/pubsub/pub?arg=udGVzdA");
    });
});

describe("pubsubPeersUrl", () => {
    it("builds correct peers URL", () => {
        const url = pubsubPeersUrl(API, "udGVzdA");
        assert.equal(url, "http://localhost:5001/api/v0/pubsub/peers?arg=udGVzdA");
    });
});

describe("pubsubLsUrl", () => {
    it("builds correct ls URL", () => {
        const url = pubsubLsUrl(API);
        assert.equal(url, "http://localhost:5001/api/v0/pubsub/ls");
    });
});

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

describe("buildPubsubPublishBody", () => {
    it("builds multipart body with correct boundary", () => {
        const { body, contentType } = buildPubsubPublishBody("test data");
        assert.ok(contentType.includes("multipart/form-data"));
        assert.ok(contentType.includes("boundary="));
        assert.ok(body.includes("test data"));
        assert.ok(body.includes("Content-Disposition: form-data"));
        assert.ok(body.includes("application/octet-stream"));
    });

    it("wraps message data in boundary markers", () => {
        const { body } = buildPubsubPublishBody("hello");
        // Must start with --boundary and end with --boundary--
        assert.ok(body.startsWith("--"));
        assert.ok(body.includes("--ad4m-pubsub-boundary--"));
    });

    it("handles JSON message data", () => {
        const msg = JSON.stringify({ type: "test", payload: 42 });
        const { body } = buildPubsubPublishBody(msg);
        assert.ok(body.includes(msg));
    });
});

// ---------------------------------------------------------------------------
// Response parsing for pubsub/peers
// ---------------------------------------------------------------------------

describe("parsePubsubPeersResponse", () => {
    it("parses peers list", () => {
        const body = JSON.stringify({
            Strings: ["12D3KooWA1", "12D3KooWB2", "12D3KooWC3"],
        });
        const peers = parsePubsubPeersResponse(body);
        assert.deepEqual(peers, ["12D3KooWA1", "12D3KooWB2", "12D3KooWC3"]);
    });

    it("handles null Strings", () => {
        const body = JSON.stringify({ Strings: null });
        const peers = parsePubsubPeersResponse(body);
        assert.deepEqual(peers, []);
    });

    it("handles empty Strings", () => {
        const body = JSON.stringify({ Strings: [] });
        const peers = parsePubsubPeersResponse(body);
        assert.deepEqual(peers, []);
    });

    it("handles missing Strings key", () => {
        const peers = parsePubsubPeersResponse("{}");
        assert.deepEqual(peers, []);
    });
});

describe("parsePubsubLsResponse", () => {
    it("parses topic list", () => {
        const body = JSON.stringify({ Strings: ["utopic1", "utopic2"] });
        const topics = parsePubsubLsResponse(body);
        assert.deepEqual(topics, ["utopic1", "utopic2"]);
    });

    it("handles null Strings", () => {
        const topics = parsePubsubLsResponse(JSON.stringify({ Strings: null }));
        assert.deepEqual(topics, []);
    });
});

// ---------------------------------------------------------------------------
// Presence tracking (heartbeat + TTL + online agent list)
// ---------------------------------------------------------------------------

describe("filterOnlineAgents", () => {
    it("filters out stale agents", () => {
        const now = 100_000;
        const records: PresenceRecord[] = [
            { did: "did:a", status: "online", timestamp: now - 10_000 },  // 10s ago — online
            { did: "did:b", status: "online", timestamp: now - 40_000 },  // 40s ago — stale
            { did: "did:c", status: "online", timestamp: now - 29_000 },  // 29s ago — online
        ];
        const online = filterOnlineAgents(records, now);
        assert.equal(online.length, 2);
        assert.ok(online.some(r => r.did === "did:a"));
        assert.ok(online.some(r => r.did === "did:c"));
    });

    it("uses custom TTL", () => {
        const now = 100_000;
        const records: PresenceRecord[] = [
            { did: "did:a", status: "online", timestamp: now - 5_000 },
        ];
        // With 3s TTL, 5s-old record is stale
        const online = filterOnlineAgents(records, now, 3_000);
        assert.equal(online.length, 0);
    });

    it("returns empty for no records", () => {
        assert.deepEqual(filterOnlineAgents([], Date.now()), []);
    });

    it("PRESENCE_TTL_MS is 30 seconds", () => {
        assert.equal(PRESENCE_TTL_MS, 30_000);
    });
});

describe("mergePresenceRecord", () => {
    it("adds new record", () => {
        const records: PresenceRecord[] = [
            { did: "did:a", status: "online", timestamp: 1000 },
        ];
        const merged = mergePresenceRecord(records, {
            did: "did:b", status: "online", timestamp: 2000,
        });
        assert.equal(merged.length, 2);
    });

    it("updates existing record by DID", () => {
        const records: PresenceRecord[] = [
            { did: "did:a", status: "online", timestamp: 1000 },
        ];
        const merged = mergePresenceRecord(records, {
            did: "did:a", status: "away", timestamp: 2000,
        });
        assert.equal(merged.length, 1);
        assert.equal(merged[0].status, "away");
        assert.equal(merged[0].timestamp, 2000);
    });

    it("does not mutate original array", () => {
        const records: PresenceRecord[] = [
            { did: "did:a", status: "online", timestamp: 1000 },
        ];
        const merged = mergePresenceRecord(records, {
            did: "did:a", status: "away", timestamp: 2000,
        });
        assert.equal(records[0].status, "online");
        assert.equal(merged[0].status, "away");
    });
});

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

describe("storage key helpers", () => {
    it("presenceStorageKey includes DID", () => {
        const key = presenceStorageKey("did:key:z6Mk1");
        assert.ok(key.includes("did:key:z6Mk1"));
        assert.ok(key.startsWith("telepresence/presence/"));
    });

    it("peerMapStorageKey includes PeerID", () => {
        const key = peerMapStorageKey("12D3KooWAbc");
        assert.ok(key.includes("12D3KooWAbc"));
        assert.ok(key.startsWith("telepresence/peermap/"));
    });

    it("presenceStoragePrefix returns correct prefix", () => {
        assert.equal(presenceStoragePrefix(), "telepresence/presence/");
    });

    it("peerMapStoragePrefix returns correct prefix", () => {
        assert.equal(peerMapStoragePrefix(), "telepresence/peermap/");
    });

    it("signalCallbackKey returns stable key", () => {
        assert.equal(signalCallbackKey(), "telepresence/signal-callback");
    });
});

// ===========================================================================
// IMPURE MODULE TESTS (with mock adapters)
// ===========================================================================

describe("pubsub impure module", () => {
    let mockStorage: MockStorageAdapter;
    let mockTransport: MockTransport;

    beforeEach(() => {
        mockStorage = new MockStorageAdapter();
        mockTransport = new MockTransport();
        initStorage(mockStorage);
        initTransport(mockTransport);
        clearSignalCallback();
    });

    // -----------------------------------------------------------------------
    // publishPresence
    // -----------------------------------------------------------------------

    describe("publishPresence", () => {
        it("publishes heartbeat via transport", async () => {
            mockTransport.addResponse("/api/v0/pubsub/pub", {
                status: 200, headers: {}, body: "{}",
            });

            await publishPresence(API, NH_URL, AGENT_DID, { online: true });

            // Should have made one HTTP request
            assert.equal(mockTransport.requests.length, 1);
            const req = mockTransport.requests[0];
            assert.ok(req.url.includes("/api/v0/pubsub/pub"));
            assert.equal(req.method, "POST");

            // Should include multibase-encoded topic in URL
            const expectedTopic = encodeTopicMultibase(presenceTopic(NH_URL));
            assert.ok(req.url.includes(expectedTopic));

            // Body should contain presence message
            assert.ok(req.body.includes('"type":"presence"'));
            assert.ok(req.body.includes(AGENT_DID));
        });

        it("stores presence record in storage", async () => {
            mockTransport.addResponse("/api/v0/pubsub/pub", {
                status: 200, headers: {}, body: "{}",
            });

            await publishPresence(API, NH_URL, AGENT_DID, "online");

            const stored = mockStorage.get(presenceStorageKey(AGENT_DID));
            assert.ok(stored !== null);
            const record = JSON.parse(stored!);
            assert.equal(record.did, AGENT_DID);
            assert.equal(record.status, "online");
            assert.ok(typeof record.timestamp === "number");
        });

        it("throws on HTTP error", async () => {
            mockTransport.addResponse("/api/v0/pubsub/pub", {
                status: 500, headers: {}, body: "Internal error",
            });

            await assert.rejects(
                () => publishPresence(API, NH_URL, AGENT_DID, "online"),
                /pubsub\/pub failed/,
            );
        });
    });

    // -----------------------------------------------------------------------
    // queryOnlineAgents
    // -----------------------------------------------------------------------

    describe("queryOnlineAgents", () => {
        it("returns agents from local presence records", async () => {
            // Setup: store a recent presence record
            const record: PresenceRecord = {
                did: AGENT_DID, status: "online", timestamp: Date.now(),
            };
            mockStorage.put(presenceStorageKey(AGENT_DID), JSON.stringify(record));

            // Mock peers response (empty)
            mockTransport.addResponse("/api/v0/pubsub/peers", {
                status: 200, headers: {}, body: JSON.stringify({ Strings: [] }),
            });

            const agents = await queryOnlineAgents(API, NH_URL);
            assert.equal(agents.length, 1);
            assert.equal(agents[0].did, AGENT_DID);
        });

        it("excludes stale presence records", async () => {
            // Store an old record (older than TTL)
            const record: PresenceRecord = {
                did: AGENT_DID, status: "online", timestamp: Date.now() - 60_000,
            };
            mockStorage.put(presenceStorageKey(AGENT_DID), JSON.stringify(record));

            mockTransport.addResponse("/api/v0/pubsub/peers", {
                status: 200, headers: {}, body: JSON.stringify({ Strings: [] }),
            });

            const agents = await queryOnlineAgents(API, NH_URL);
            assert.equal(agents.length, 0);
        });

        it("includes peer-mapped agents from peers endpoint", async () => {
            // Store a PeerID → DID mapping
            mockStorage.put(peerMapStorageKey("12D3KooWAbc"), REMOTE_DID);

            // peers endpoint returns that PeerID
            mockTransport.addResponse("/api/v0/pubsub/peers", {
                status: 200, headers: {},
                body: JSON.stringify({ Strings: ["12D3KooWAbc"] }),
            });

            const agents = await queryOnlineAgents(API, NH_URL);
            assert.equal(agents.length, 1);
            assert.equal(agents[0].did, REMOTE_DID);
        });

        it("handles peers endpoint failure gracefully", async () => {
            // Store a valid presence record
            const record: PresenceRecord = {
                did: AGENT_DID, status: "online", timestamp: Date.now(),
            };
            mockStorage.put(presenceStorageKey(AGENT_DID), JSON.stringify(record));

            mockTransport.addResponse("/api/v0/pubsub/peers", {
                status: 500, headers: {}, body: "Error",
            });

            // Should still return local records
            const agents = await queryOnlineAgents(API, NH_URL);
            assert.equal(agents.length, 1);
        });
    });

    // -----------------------------------------------------------------------
    // sendSignal
    // -----------------------------------------------------------------------

    describe("sendSignal", () => {
        it("publishes signal to target DID topic", async () => {
            mockTransport.addResponse("/api/v0/pubsub/pub", {
                status: 200, headers: {}, body: "{}",
            });

            const result = await sendSignal(
                API, NH_URL, AGENT_DID, REMOTE_DID, { action: "ping" },
            );

            assert.equal(mockTransport.requests.length, 1);
            const req = mockTransport.requests[0];

            // Topic should be for the remote DID
            const expectedTopic = encodeTopicMultibase(signalTopic(NH_URL, REMOTE_DID));
            assert.ok(req.url.includes(expectedTopic));

            // Body should contain signal message
            assert.ok(req.body.includes('"type":"signal"'));
            assert.ok(req.body.includes(AGENT_DID));

            // Result should have status
            assert.equal((result as any).status, "sent");
        });
    });

    // -----------------------------------------------------------------------
    // sendBroadcast
    // -----------------------------------------------------------------------

    describe("sendBroadcast", () => {
        it("publishes broadcast to neighbourhood topic", async () => {
            mockTransport.addResponse("/api/v0/pubsub/pub", {
                status: 200, headers: {}, body: "{}",
            });

            const result = await sendBroadcast(
                API, NH_URL, AGENT_DID, { message: "hello everyone" },
            );

            assert.equal(mockTransport.requests.length, 1);
            const req = mockTransport.requests[0];

            // Topic should be the broadcast topic
            const expectedTopic = encodeTopicMultibase(broadcastTopic(NH_URL));
            assert.ok(req.url.includes(expectedTopic));

            // Body should contain broadcast message
            assert.ok(req.body.includes('"type":"broadcast"'));

            assert.equal((result as any).status, "sent");
        });
    });

    // -----------------------------------------------------------------------
    // Signal callback
    // -----------------------------------------------------------------------

    describe("signal callback", () => {
        it("registerSignalCallback stores callback", () => {
            const cb = (_p: PubSubMessage) => {};
            registerSignalCallback(cb);
            assert.equal(getSignalCallback(), cb);
        });

        it("clearSignalCallback removes callback", () => {
            registerSignalCallback((_p: PubSubMessage) => {});
            clearSignalCallback();
            assert.equal(getSignalCallback(), null);
        });

        it("deliverSignal invokes registered callback", () => {
            let received: PubSubMessage | null = null;
            registerSignalCallback((p: PubSubMessage) => { received = p; });

            const msg = buildSignalMessage(AGENT_DID, { test: true }, Date.now());
            deliverSignal(msg);

            assert.ok(received !== null);
            assert.equal((received as any).type, "signal");
        });

        it("deliverSignal does nothing without callback", () => {
            // Should not throw
            const msg = buildSignalMessage(AGENT_DID, { test: true }, Date.now());
            deliverSignal(msg);
        });
    });

    // -----------------------------------------------------------------------
    // PeerID ↔ DID mapping
    // -----------------------------------------------------------------------

    describe("PeerID-DID mapping", () => {
        it("storePeerMapping stores and lookupPeerDid retrieves", () => {
            storePeerMapping("12D3KooWAbc", AGENT_DID);
            const did = lookupPeerDid("12D3KooWAbc");
            assert.equal(did, AGENT_DID);
        });

        it("lookupPeerDid returns null for unknown PeerID", () => {
            const did = lookupPeerDid("12D3KooWUnknown");
            assert.equal(did, null);
        });

        it("storePeerMapping overwrites existing mapping", () => {
            storePeerMapping("12D3KooWAbc", AGENT_DID);
            storePeerMapping("12D3KooWAbc", REMOTE_DID);
            assert.equal(lookupPeerDid("12D3KooWAbc"), REMOTE_DID);
        });
    });

    // -----------------------------------------------------------------------
    // storePresenceRecord
    // -----------------------------------------------------------------------

    describe("storePresenceRecord", () => {
        it("stores and can be retrieved from storage", () => {
            const record: PresenceRecord = {
                did: AGENT_DID,
                status: "active",
                timestamp: Date.now(),
            };
            storePresenceRecord(record);

            const stored = mockStorage.get(presenceStorageKey(AGENT_DID));
            assert.ok(stored !== null);
            const parsed = JSON.parse(stored!);
            assert.equal(parsed.did, AGENT_DID);
            assert.equal(parsed.status, "active");
        });
    });
});

// ---------------------------------------------------------------------------
// Integration: topic encoding roundtrip
// ---------------------------------------------------------------------------

describe("topic encoding integration", () => {
    it("encodes and can decode presence topic", () => {
        const topic = presenceTopic("QmNeighbourhoodAbc123");
        const encoded = encodeTopicMultibase(topic);

        // Decode: strip u prefix, convert base64url to standard, decode
        const b64url = encoded.slice(1);
        const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
        const decoded = atob(padded);
        assert.equal(decoded, topic);
    });

    it("encodes signal topic with special DID characters", () => {
        const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
        const topic = signalTopic("QmTest", did);
        const encoded = encodeTopicMultibase(topic);

        // Should encode without error and be decodable
        assert.ok(encoded.startsWith("u"));
        assert.ok(encoded.length > 10);

        // Roundtrip
        const b64url = encoded.slice(1);
        const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
        const decoded = atob(padded);
        assert.equal(decoded, topic);
    });

    it("URL-encodes properly in pubsub/pub URL", () => {
        const topic = presenceTopic("QmTest");
        const encoded = encodeTopicMultibase(topic);
        const url = pubsubPubUrl(API, encoded);
        assert.ok(url.includes(encoded));
        assert.ok(url.includes("/api/v0/pubsub/pub?arg="));
    });
});
