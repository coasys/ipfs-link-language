/**
 * Tests for dual-language deduplication logic (pure module).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isDuplicate,
    linkContentHash,
    linkOriginKey,
    shouldPublish,
    isExcludedPredicate,
} from "../src/translate.js";

import type { LinkOrigin } from "../src/translate.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

function makeLink(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
            ...overrides,
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe("isDuplicate", () => {
    it("returns false when no existing hashes", () => {
        const link = makeLink();
        const existing = new Set<string>();
        assert.equal(isDuplicate(link, existing, simpleHash), false);
    });

    it("returns true when content hash matches existing", () => {
        const link = makeLink();
        const contentHash = linkContentHash(link, simpleHash);
        const existing = new Set<string>([contentHash]);
        assert.equal(isDuplicate(link, existing, simpleHash), true);
    });

    it("returns false for different link content", () => {
        const link1 = makeLink({ source: "a", target: "b", predicate: "c" });
        const link2 = makeLink({ source: "x", target: "y", predicate: "z" });
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), false);
    });

    it("deduplicates based on triple only (ignores author/timestamp)", () => {
        const link1 = makeLink();
        const link2: LinkExpression = {
            ...makeLink(),
            author: "did:key:z6MkOther",
            timestamp: "2026-06-01T00:00:00.000Z",
        };
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), true);
    });
});

// ---------------------------------------------------------------------------
// linkContentHash
// ---------------------------------------------------------------------------

describe("linkContentHash", () => {
    it("produces deterministic hash", () => {
        const link = makeLink();
        const hash1 = linkContentHash(link, simpleHash);
        const hash2 = linkContentHash(link, simpleHash);
        assert.equal(hash1, hash2);
    });

    it("produces different hashes for different links", () => {
        const link1 = makeLink({ source: "a" });
        const link2 = makeLink({ source: "b" });
        assert.notEqual(
            linkContentHash(link1, simpleHash),
            linkContentHash(link2, simpleHash),
        );
    });

    it("ignores author and timestamp in hash", () => {
        const link1 = makeLink();
        const link2: LinkExpression = {
            ...makeLink(),
            author: "did:key:z6MkDifferent",
            timestamp: "2099-01-01T00:00:00.000Z",
        };
        assert.equal(
            linkContentHash(link1, simpleHash),
            linkContentHash(link2, simpleHash),
        );
    });
});

// ---------------------------------------------------------------------------
// linkOriginKey
// ---------------------------------------------------------------------------

describe("linkOriginKey", () => {
    it("produces correct storage key format", () => {
        assert.equal(linkOriginKey("abc123"), "link-origin/abc123");
    });

    it("handles empty hash", () => {
        assert.equal(linkOriginKey(""), "link-origin/");
    });

    it("handles hash with special characters", () => {
        assert.equal(linkOriginKey("Qm/abc"), "link-origin/Qm/abc");
    });
});

// ---------------------------------------------------------------------------
// shouldPublish
// ---------------------------------------------------------------------------

describe("shouldPublish", () => {
    it("returns true when no origin is tracked (new local commit)", () => {
        const getOrigin = (_key: string): string | null => null;
        assert.equal(shouldPublish("hash123", getOrigin), true);
    });

    it("returns true for native-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash123") return "native";
            return null;
        };
        assert.equal(shouldPublish("hash123", getOrigin), true);
    });

    it("returns true for dual-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash456") return "dual";
            return null;
        };
        assert.equal(shouldPublish("hash456", getOrigin), true);
    });

    it("returns false for ipfs-origin links (prevents echo loop)", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash789") return "ipfs";
            return null;
        };
        assert.equal(shouldPublish("hash789", getOrigin), false);
    });

    it("constructs correct storage key for lookup", () => {
        let queriedKey = "";
        const getOrigin = (key: string): string | null => {
            queriedKey = key;
            return null;
        };
        shouldPublish("myLinkHash", getOrigin);
        assert.equal(queriedKey, "link-origin/myLinkHash");
    });
});

// ---------------------------------------------------------------------------
// isExcludedPredicate
// ---------------------------------------------------------------------------

describe("isExcludedPredicate", () => {
    it("returns false for empty predicate", () => {
        assert.equal(isExcludedPredicate("", ["flux://internal"]), false);
    });

    it("returns false for undefined predicate", () => {
        assert.equal(isExcludedPredicate(undefined, ["flux://internal"]), false);
    });

    it("returns true for excluded predicate", () => {
        assert.equal(isExcludedPredicate("flux://internal", ["flux://internal"]), true);
    });

    it("returns false for non-excluded predicate", () => {
        assert.equal(isExcludedPredicate("flux://has_message", ["flux://internal"]), false);
    });

    it("returns false for empty excludePredicates", () => {
        assert.equal(isExcludedPredicate("flux://has_message", []), false);
    });

    it("checks multiple exclusions", () => {
        const excludes = ["flux://internal", "debug://log", "test://only"];
        assert.equal(isExcludedPredicate("debug://log", excludes), true);
        assert.equal(isExcludedPredicate("flux://has_message", excludes), false);
    });
});
