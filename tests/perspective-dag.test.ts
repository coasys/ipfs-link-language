/**
 * Tests for Perspective DAG commit node construction (pure logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildCommitNode,
    buildGenesisCommit,
    buildMergeCommit,
    getPreviousCid,
    getParentCids,
    isValidCommitNode,
    commitSize,
} from "../src/perspective-dag.js";
import type { PerspectiveCommitNode } from "../src/perspective-dag.js";
import type { LinkNode } from "../src/translate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkNode(index: number = 1): LinkNode {
    return {
        type: "ad4m:LinkExpression",
        source: `channel://chan-${index}`,
        target: `expr://msg-${index}`,
        predicate: "flux://has_message",
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// buildCommitNode
// ---------------------------------------------------------------------------

describe("buildCommitNode", () => {
    it("creates a commit with additions and removals", () => {
        const additions = [makeLinkNode(1), makeLinkNode(2)];
        const removals = [makeLinkNode(3)];
        const node = buildCommitNode("did:key:z6MkTest", additions, removals, "bafyPrev", "2026-05-02T12:00:00.000Z");

        assert.equal(node.type, "ad4m:PerspectiveCommit");
        assert.equal(node.author, "did:key:z6MkTest");
        assert.equal(node.timestamp, "2026-05-02T12:00:00.000Z");
        assert.equal(node.additions.length, 2);
        assert.equal(node.removals.length, 1);
        assert.deepEqual(node.previous, [{ "/": "bafyPrev" }]);
    });

    it("creates genesis commit with empty parent array", () => {
        const node = buildCommitNode("did:key:z6MkTest", [makeLinkNode()], [], null);
        assert.deepEqual(node.previous, []);
    });

    it("accepts an array of parent CIDs (merge commit)", () => {
        const node = buildCommitNode("did:key:z6MkTest", [], [], ["bafyA", "bafyB"]);
        assert.deepEqual(node.previous, [{ "/": "bafyA" }, { "/": "bafyB" }]);
        assert.deepEqual(getParentCids(node), ["bafyA", "bafyB"]);
    });

    it("auto-generates timestamp if not provided", () => {
        const node = buildCommitNode("did:key:z6MkTest", [], [], null);
        assert.ok(node.timestamp);
        assert.ok(node.timestamp.includes("T"));
    });

    it("handles empty additions and removals", () => {
        const node = buildCommitNode("did:key:z6MkTest", [], [], "bafyPrev");
        assert.equal(node.additions.length, 0);
        assert.equal(node.removals.length, 0);
    });
});

// ---------------------------------------------------------------------------
// buildGenesisCommit
// ---------------------------------------------------------------------------

describe("buildGenesisCommit", () => {
    it("creates a commit with an empty parent array", () => {
        const node = buildGenesisCommit("did:key:z6MkTest", [makeLinkNode()]);
        assert.deepEqual(node.previous, []);
        assert.equal(node.removals.length, 0);
    });

    it("sets the type correctly", () => {
        const node = buildGenesisCommit("did:key:z6MkTest", []);
        assert.equal(node.type, "ad4m:PerspectiveCommit");
    });
});

// ---------------------------------------------------------------------------
// getPreviousCid
// ---------------------------------------------------------------------------

describe("getPreviousCid", () => {
    it("returns CID from previous link", () => {
        const node = buildCommitNode("did:key:z6MkTest", [], [], "bafyABC123");
        assert.equal(getPreviousCid(node), "bafyABC123");
    });

    it("returns null for genesis commit", () => {
        const node = buildGenesisCommit("did:key:z6MkTest", []);
        assert.equal(getPreviousCid(node), null);
    });
});

// ---------------------------------------------------------------------------
// isValidCommitNode
// ---------------------------------------------------------------------------

describe("isValidCommitNode", () => {
    it("returns true for a valid commit node", () => {
        const node = buildCommitNode("did:key:z6MkTest", [makeLinkNode()], [], "bafyPrev");
        assert.equal(isValidCommitNode(node), true);
    });

    it("returns true for genesis commit", () => {
        const node = buildGenesisCommit("did:key:z6MkTest", []);
        assert.equal(isValidCommitNode(node), true);
    });

    it("returns false for null", () => {
        assert.equal(isValidCommitNode(null), false);
    });

    it("returns false for undefined", () => {
        assert.equal(isValidCommitNode(undefined), false);
    });

    it("returns false for wrong type", () => {
        const node = { ...buildCommitNode("a", [], [], null), type: "wrong" };
        assert.equal(isValidCommitNode(node), false);
    });

    it("returns false for missing author", () => {
        const node: any = buildCommitNode("a", [], [], null);
        delete node.author;
        assert.equal(isValidCommitNode(node), false);
    });

    it("returns false for missing timestamp", () => {
        const node: any = buildCommitNode("a", [], [], null);
        delete node.timestamp;
        assert.equal(isValidCommitNode(node), false);
    });

    it("returns false for non-array additions", () => {
        const node: any = buildCommitNode("a", [], [], null);
        node.additions = "not-an-array";
        assert.equal(isValidCommitNode(node), false);
    });

    it("returns false for non-array removals", () => {
        const node: any = buildCommitNode("a", [], [], null);
        node.removals = "not-an-array";
        assert.equal(isValidCommitNode(node), false);
    });
});

// ---------------------------------------------------------------------------
// commitSize
// ---------------------------------------------------------------------------

describe("commitSize", () => {
    it("returns total additions + removals", () => {
        const node = buildCommitNode("a", [makeLinkNode(1), makeLinkNode(2)], [makeLinkNode(3)], null);
        assert.equal(commitSize(node), 3);
    });

    it("returns 0 for empty commit", () => {
        const node = buildCommitNode("a", [], [], null);
        assert.equal(commitSize(node), 0);
    });

    it("returns additions-only count", () => {
        const node = buildCommitNode("a", [makeLinkNode(1)], [], null);
        assert.equal(commitSize(node), 1);
    });

    it("returns removals-only count", () => {
        const node = buildCommitNode("a", [], [makeLinkNode(1)], null);
        assert.equal(commitSize(node), 1);
    });
});

// ---------------------------------------------------------------------------
// buildMergeCommit
// ---------------------------------------------------------------------------

describe("buildMergeCommit", () => {
    it("creates a commit with all heads as parents", () => {
        const node = buildMergeCommit("did:key:z6MkMerge", ["bafyA", "bafyB"]);
        assert.equal(node.type, "ad4m:PerspectiveCommit");
        assert.deepEqual(getParentCids(node), ["bafyA", "bafyB"]);
    });

    it("sorts parents so the merge is order-independent", () => {
        const a = buildMergeCommit("did:x", ["bafyB", "bafyA"]);
        const b = buildMergeCommit("did:x", ["bafyA", "bafyB"]);
        assert.deepEqual(getParentCids(a), getParentCids(b));
        assert.deepEqual(getParentCids(a), ["bafyA", "bafyB"]);
    });

    it("dedupes duplicate parent CIDs", () => {
        const node = buildMergeCommit("did:x", ["bafyA", "bafyA", "bafyB"]);
        assert.deepEqual(getParentCids(node), ["bafyA", "bafyB"]);
    });

    it("carries no link diffs by default", () => {
        const node = buildMergeCommit("did:x", ["bafyA", "bafyB"]);
        assert.equal(node.additions.length, 0);
        assert.equal(node.removals.length, 0);
    });
});
