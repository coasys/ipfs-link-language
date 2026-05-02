/**
 * Tests for Link ↔ DAG node (round-trip) translation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToNode,
    nodeToLink,
    linkContentKey,
    isValidLinkNode,
    linksToNodes,
    nodesToLinks,
} from "../src/translate.pure.js";
import type { LinkNode } from "../src/translate.pure.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeNode(overrides?: Partial<LinkNode>): LinkNode {
    return {
        type: "ad4m:LinkExpression",
        source: "channel://main",
        target: "expr://msg-001",
        predicate: "flux://has_message",
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// linkToNode
// ---------------------------------------------------------------------------

describe("linkToNode", () => {
    it("converts a LinkExpression to a LinkNode", () => {
        const link = makeLink();
        const node = linkToNode(link);
        assert.equal(node.type, "ad4m:LinkExpression");
        assert.equal(node.source, "channel://main");
        assert.equal(node.target, "expr://msg-001");
        assert.equal(node.predicate, "flux://has_message");
        assert.equal(node.author, "did:key:z6MkTest");
        assert.equal(node.timestamp, "2026-05-02T00:00:00.000Z");
        assert.equal(node.proof.signature, "abc123");
        assert.equal(node.proof.key, "key123");
    });

    it("handles empty fields", () => {
        const link = makeLink({
            data: { source: "", target: "", predicate: undefined },
        });
        const node = linkToNode(link);
        assert.equal(node.source, "");
        assert.equal(node.target, "");
        assert.equal(node.predicate, "");
    });

    it("handles missing proof", () => {
        const link: LinkExpression = {
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            data: { source: "a", target: "b" },
            proof: { signature: "", key: "" },
        };
        const node = linkToNode(link);
        assert.equal(node.proof.signature, "");
        assert.equal(node.proof.key, "");
    });
});

// ---------------------------------------------------------------------------
// nodeToLink
// ---------------------------------------------------------------------------

describe("nodeToLink", () => {
    it("converts a LinkNode back to a LinkExpression", () => {
        const node = makeNode();
        const link = nodeToLink(node);
        assert.equal(link.author, "did:key:z6MkTest");
        assert.equal(link.timestamp, "2026-05-02T00:00:00.000Z");
        assert.equal(link.data.source, "channel://main");
        assert.equal(link.data.target, "expr://msg-001");
        assert.equal(link.data.predicate, "flux://has_message");
        assert.equal(link.proof.signature, "abc123");
        assert.equal(link.proof.key, "key123");
    });

    it("handles missing proof fields", () => {
        const node = makeNode({ proof: { signature: "", key: "" } });
        const link = nodeToLink(node);
        assert.equal(link.proof.signature, "");
        assert.equal(link.proof.key, "");
    });
});

// ---------------------------------------------------------------------------
// Round-trip: link → node → link
// ---------------------------------------------------------------------------

describe("Round-trip translation", () => {
    it("link → node → link is lossless", () => {
        const original = makeLink();
        const node = linkToNode(original);
        const recovered = nodeToLink(node);

        assert.equal(recovered.author, original.author);
        assert.equal(recovered.timestamp, original.timestamp);
        assert.equal(recovered.data.source, original.data.source);
        assert.equal(recovered.data.target, original.data.target);
        assert.equal(recovered.data.predicate, original.data.predicate);
        assert.equal(recovered.proof.signature, original.proof.signature);
        assert.equal(recovered.proof.key, original.proof.key);
    });

    it("node → link → node is lossless", () => {
        const original = makeNode();
        const link = nodeToLink(original);
        const recovered = linkToNode(link);

        assert.equal(recovered.type, original.type);
        assert.equal(recovered.source, original.source);
        assert.equal(recovered.target, original.target);
        assert.equal(recovered.predicate, original.predicate);
        assert.equal(recovered.author, original.author);
        assert.equal(recovered.timestamp, original.timestamp);
        assert.equal(recovered.proof.signature, original.proof.signature);
        assert.equal(recovered.proof.key, original.proof.key);
    });

    it("handles empty predicate round-trip", () => {
        const original = makeLink({ data: { source: "a", target: "b", predicate: "" } });
        const node = linkToNode(original);
        const recovered = nodeToLink(node);
        assert.equal(recovered.data.predicate, "");
    });

    it("handles undefined predicate round-trip", () => {
        const original = makeLink({ data: { source: "a", target: "b", predicate: undefined } });
        const node = linkToNode(original);
        const recovered = nodeToLink(node);
        assert.equal(recovered.data.predicate, "");
    });

    it("handles special characters in URIs", () => {
        const original = makeLink({
            data: {
                source: "literal://hello world & friends",
                target: "expr://Qm<abc>123",
                predicate: "flux://has_message/🔗",
            },
        });
        const node = linkToNode(original);
        const recovered = nodeToLink(node);
        assert.equal(recovered.data.source, original.data.source);
        assert.equal(recovered.data.target, original.data.target);
        assert.equal(recovered.data.predicate, original.data.predicate);
    });
});

// ---------------------------------------------------------------------------
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey", () => {
    it("produces a deterministic content key", () => {
        const link = makeLink();
        const k1 = linkContentKey(link);
        const k2 = linkContentKey(link);
        assert.equal(k1, k2);
    });

    it("produces different keys for different links", () => {
        const link1 = makeLink();
        const link2 = makeLink({
            data: { source: "different", target: "links", predicate: "pred" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });

    it("includes author and timestamp", () => {
        const key = linkContentKey(makeLink());
        assert.ok(key.includes("did:key:z6MkTest"));
        assert.ok(key.includes("2026-05-02"));
    });
});

// ---------------------------------------------------------------------------
// isValidLinkNode
// ---------------------------------------------------------------------------

describe("isValidLinkNode", () => {
    it("returns true for a valid LinkNode", () => {
        assert.equal(isValidLinkNode(makeNode()), true);
    });

    it("returns false for null", () => {
        assert.equal(isValidLinkNode(null), false);
    });

    it("returns false for undefined", () => {
        assert.equal(isValidLinkNode(undefined), false);
    });

    it("returns false for wrong type", () => {
        assert.equal(isValidLinkNode({ ...makeNode(), type: "wrong" }), false);
    });

    it("returns false for missing source", () => {
        const node: any = { ...makeNode() };
        delete node.source;
        assert.equal(isValidLinkNode(node), false);
    });

    it("returns false for missing author", () => {
        const node: any = { ...makeNode() };
        delete node.author;
        assert.equal(isValidLinkNode(node), false);
    });

    it("returns false for missing proof", () => {
        const node: any = { ...makeNode() };
        delete node.proof;
        assert.equal(isValidLinkNode(node), false);
    });

    it("returns false for null proof", () => {
        assert.equal(isValidLinkNode({ ...makeNode(), proof: null }), false);
    });
});

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

describe("linksToNodes / nodesToLinks", () => {
    it("batch converts links to nodes", () => {
        const links = [makeLink(), makeLink({ timestamp: "2026-05-03T00:00:00.000Z" })];
        const nodes = linksToNodes(links);
        assert.equal(nodes.length, 2);
        assert.equal(nodes[0].type, "ad4m:LinkExpression");
        assert.equal(nodes[1].type, "ad4m:LinkExpression");
    });

    it("batch converts nodes to links", () => {
        const nodes = [makeNode(), makeNode({ author: "did:key:z6MkOther" })];
        const links = nodesToLinks(nodes);
        assert.equal(links.length, 2);
        assert.equal(links[0].author, "did:key:z6MkTest");
        assert.equal(links[1].author, "did:key:z6MkOther");
    });

    it("batch round-trip preserves all data", () => {
        const origLinks = [
            makeLink(),
            makeLink({
                data: { source: "x", target: "y", predicate: "z" },
                author: "did:key:z6MkOther",
                timestamp: "2026-06-01T00:00:00.000Z",
            }),
        ];
        const nodes = linksToNodes(origLinks);
        const recoveredLinks = nodesToLinks(nodes);
        assert.equal(recoveredLinks.length, origLinks.length);
        for (let i = 0; i < origLinks.length; i++) {
            assert.equal(recoveredLinks[i].data.source, origLinks[i].data.source);
            assert.equal(recoveredLinks[i].data.target, origLinks[i].data.target);
            assert.equal(recoveredLinks[i].author, origLinks[i].author);
        }
    });

    it("handles empty arrays", () => {
        assert.deepEqual(linksToNodes([]), []);
        assert.deepEqual(nodesToLinks([]), []);
    });
});
