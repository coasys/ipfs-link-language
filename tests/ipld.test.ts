/**
 * Tests for DAG-JSON serialization round-trip (pure logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    dagJsonEncode,
    dagJsonDecode,
    dagLink,
    isDagJsonLink,
    dagJsonContentKey,
} from "../src/ipld.js";

// ---------------------------------------------------------------------------
// dagJsonEncode / dagJsonDecode
// ---------------------------------------------------------------------------

describe("dagJsonEncode", () => {
    it("encodes a simple object", () => {
        const result = dagJsonEncode({ hello: "world" });
        assert.equal(result, '{"hello":"world"}');
    });

    it("encodes with sorted keys for determinism", () => {
        const result = dagJsonEncode({ z: 1, a: 2, m: 3 });
        assert.equal(result, '{"a":2,"m":3,"z":1}');
    });

    it("encodes nested objects with sorted keys", () => {
        const result = dagJsonEncode({ b: { z: 1, a: 2 }, a: 1 });
        assert.equal(result, '{"a":1,"b":{"a":2,"z":1}}');
    });

    it("encodes arrays preserving order", () => {
        const result = dagJsonEncode({ items: [3, 1, 2] });
        assert.equal(result, '{"items":[3,1,2]}');
    });

    it("encodes null", () => {
        const result = dagJsonEncode(null);
        assert.equal(result, "null");
    });

    it("encodes a string", () => {
        const result = dagJsonEncode("hello");
        assert.equal(result, '"hello"');
    });

    it("encodes a number", () => {
        const result = dagJsonEncode(42);
        assert.equal(result, "42");
    });

    it("is deterministic (same input → same output)", () => {
        const data = { type: "ad4m:LinkExpression", source: "a", target: "b" };
        const r1 = dagJsonEncode(data);
        const r2 = dagJsonEncode(data);
        assert.equal(r1, r2);
    });

    it("encodes empty object", () => {
        assert.equal(dagJsonEncode({}), "{}");
    });

    it("encodes empty array", () => {
        assert.equal(dagJsonEncode([]), "[]");
    });
});

describe("dagJsonDecode", () => {
    it("decodes a JSON string to an object", () => {
        const result = dagJsonDecode<{ hello: string }>('{"hello":"world"}');
        assert.equal(result.hello, "world");
    });

    it("round-trips an object", () => {
        const original = { type: "ad4m:LinkExpression", source: "a", target: "b", predicate: "c" };
        const encoded = dagJsonEncode(original);
        const decoded = dagJsonDecode<typeof original>(encoded);
        assert.deepEqual(decoded, original);
    });

    it("round-trips nested objects", () => {
        const original = { proof: { signature: "abc", key: "def" }, data: { source: "x" } };
        const encoded = dagJsonEncode(original);
        const decoded = dagJsonDecode<typeof original>(encoded);
        assert.deepEqual(decoded, original);
    });

    it("round-trips arrays", () => {
        const original = { items: [1, 2, 3] };
        const encoded = dagJsonEncode(original);
        const decoded = dagJsonDecode<typeof original>(encoded);
        assert.deepEqual(decoded, original);
    });

    it("throws on invalid JSON", () => {
        assert.throws(() => dagJsonDecode("not json"), SyntaxError);
    });
});

// ---------------------------------------------------------------------------
// dagLink / isDagJsonLink
// ---------------------------------------------------------------------------

describe("dagLink", () => {
    it("creates a DAG-JSON link", () => {
        const link = dagLink("bafyreiabc123");
        assert.deepEqual(link, { "/": "bafyreiabc123" });
    });

    it("creates a link that passes isDagJsonLink", () => {
        const link = dagLink("bafyrei123");
        assert.equal(isDagJsonLink(link), true);
    });
});

describe("isDagJsonLink", () => {
    it("returns true for a valid link", () => {
        assert.equal(isDagJsonLink({ "/": "bafyrei123" }), true);
    });

    it("returns false for an object with extra keys", () => {
        assert.equal(isDagJsonLink({ "/": "bafyrei123", extra: "key" }), false);
    });

    it("returns false for null", () => {
        assert.equal(isDagJsonLink(null), false);
    });

    it("returns false for undefined", () => {
        assert.equal(isDagJsonLink(undefined), false);
    });

    it("returns false for a string", () => {
        assert.equal(isDagJsonLink("bafyrei123"), false);
    });

    it("returns false for a number", () => {
        assert.equal(isDagJsonLink(42), false);
    });

    it("returns false for an object without /", () => {
        assert.equal(isDagJsonLink({ cid: "bafyrei123" }), false);
    });

    it("returns false for an object with non-string /", () => {
        assert.equal(isDagJsonLink({ "/": 123 }), false);
    });
});

// ---------------------------------------------------------------------------
// dagJsonContentKey
// ---------------------------------------------------------------------------

describe("dagJsonContentKey", () => {
    it("produces a deterministic content key", () => {
        const data = { type: "test", value: 42 };
        const k1 = dagJsonContentKey(data);
        const k2 = dagJsonContentKey(data);
        assert.equal(k1, k2);
    });

    it("produces different keys for different data", () => {
        const k1 = dagJsonContentKey({ a: 1 });
        const k2 = dagJsonContentKey({ a: 2 });
        assert.notEqual(k1, k2);
    });

    it("is order-independent due to key sorting", () => {
        const k1 = dagJsonContentKey({ b: 2, a: 1 });
        const k2 = dagJsonContentKey({ a: 1, b: 2 });
        assert.equal(k1, k2);
    });

    it("returns a hex string", () => {
        const key = dagJsonContentKey({ test: "data" });
        assert.match(key, /^[0-9a-f]+$/);
    });
});
