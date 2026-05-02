/**
 * Tests for CID string handling (pure logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    base58btcEncode,
    base58btcDecode,
    base32Encode,
    base32Decode,
    parseCID,
    buildCIDv1,
    isCID,
    cidToBase32,
    writeVarint,
} from "../src/cid.pure.js";

// ---------------------------------------------------------------------------
// Base58btc
// ---------------------------------------------------------------------------

describe("base58btcEncode / base58btcDecode", () => {
    it("round-trips a byte array", () => {
        const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const encoded = base58btcEncode(original);
        const decoded = base58btcDecode(encoded);
        assert.deepEqual(decoded, original);
    });

    it("handles empty input", () => {
        const encoded = base58btcEncode(new Uint8Array(0));
        assert.equal(encoded, "");
        const decoded = base58btcDecode("");
        assert.deepEqual(decoded, new Uint8Array(0));
    });

    it("handles leading zeros", () => {
        const input = new Uint8Array([0, 0, 1, 2, 3]);
        const encoded = base58btcEncode(input);
        assert.ok(encoded.startsWith("11"), "Leading zeros should produce leading '1's");
        const decoded = base58btcDecode(encoded);
        assert.deepEqual(decoded, input);
    });

    it("encodes known values", () => {
        // "Hello" in base58btc
        const hello = new TextEncoder().encode("Hello");
        const encoded = base58btcEncode(hello);
        assert.ok(encoded.length > 0);
        const decoded = base58btcDecode(encoded);
        assert.deepEqual(decoded, hello);
    });

    it("throws on invalid base58 characters", () => {
        assert.throws(() => base58btcDecode("0OIl"), /Invalid base58 character/);
    });

    it("single byte round-trip", () => {
        for (const byte of [0, 1, 127, 255]) {
            const input = new Uint8Array([byte]);
            const encoded = base58btcEncode(input);
            const decoded = base58btcDecode(encoded);
            assert.deepEqual(decoded, input, `Failed for byte ${byte}`);
        }
    });
});

// ---------------------------------------------------------------------------
// Base32
// ---------------------------------------------------------------------------

describe("base32Encode / base32Decode", () => {
    it("round-trips a byte array", () => {
        const original = new Uint8Array([72, 101, 108, 108, 111]);
        const encoded = base32Encode(original);
        const decoded = base32Decode(encoded);
        assert.deepEqual(decoded, original);
    });

    it("handles empty input", () => {
        assert.equal(base32Encode(new Uint8Array(0)), "");
    });

    it("produces lowercase output", () => {
        const encoded = base32Encode(new Uint8Array([255, 128, 64]));
        assert.equal(encoded, encoded.toLowerCase());
    });

    it("round-trips various lengths", () => {
        for (let len = 1; len <= 20; len++) {
            const input = new Uint8Array(len).fill(len);
            const encoded = base32Encode(input);
            const decoded = base32Decode(encoded);
            assert.deepEqual(decoded, input, `Failed for length ${len}`);
        }
    });
});

// ---------------------------------------------------------------------------
// writeVarint
// ---------------------------------------------------------------------------

describe("writeVarint", () => {
    it("encodes small values in one byte", () => {
        const result = writeVarint(0);
        assert.deepEqual(result, new Uint8Array([0]));
    });

    it("encodes 1 in one byte", () => {
        const result = writeVarint(1);
        assert.deepEqual(result, new Uint8Array([1]));
    });

    it("encodes 127 in one byte", () => {
        const result = writeVarint(127);
        assert.deepEqual(result, new Uint8Array([127]));
    });

    it("encodes 128 in two bytes", () => {
        const result = writeVarint(128);
        assert.deepEqual(result, new Uint8Array([0x80, 0x01]));
    });

    it("encodes 0x12 (SHA-256 code)", () => {
        const result = writeVarint(0x12);
        assert.deepEqual(result, new Uint8Array([0x12]));
    });

    it("encodes 0x0129 (dag-json codec)", () => {
        const result = writeVarint(0x0129);
        // 0x0129 = 297 decimal
        // byte 1: 297 & 0x7f = 0x29 | 0x80 = 0xa9
        // byte 2: 297 >> 7 = 2 → 0x02
        assert.deepEqual(result, new Uint8Array([0xa9, 0x02]));
    });
});

// ---------------------------------------------------------------------------
// buildCIDv1
// ---------------------------------------------------------------------------

describe("buildCIDv1", () => {
    it("builds a base32 CIDv1 string starting with 'b'", () => {
        const digest = new Uint8Array(32).fill(0xab);
        const cid = buildCIDv1(0x0129, 0x12, digest);
        assert.ok(cid.startsWith("b"), `Expected CID to start with 'b', got: ${cid}`);
    });

    it("produces a parseable CID", () => {
        const digest = new Uint8Array(32).fill(0xcd);
        const cid = buildCIDv1(0x0129, 0x12, digest);
        const parsed = parseCID(cid);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.codec, 0x0129);
        assert.equal(parsed.hashFunction, 0x12);
        assert.equal(parsed.hashLength, 32);
        assert.deepEqual(parsed.digest, digest);
    });

    it("different digests produce different CIDs", () => {
        const d1 = new Uint8Array(32).fill(0x01);
        const d2 = new Uint8Array(32).fill(0x02);
        const cid1 = buildCIDv1(0x0129, 0x12, d1);
        const cid2 = buildCIDv1(0x0129, 0x12, d2);
        assert.notEqual(cid1, cid2);
    });
});

// ---------------------------------------------------------------------------
// parseCID
// ---------------------------------------------------------------------------

describe("parseCID", () => {
    it("parses a CIDv1 built by buildCIDv1", () => {
        const digest = new Uint8Array(32).fill(0xef);
        const cid = buildCIDv1(0x0129, 0x12, digest);
        const parsed = parseCID(cid);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.codec, 0x0129);
        assert.equal(parsed.hashFunction, 0x12);
        assert.deepEqual(parsed.digest, digest);
        assert.equal(parsed.original, cid);
    });

    it("throws for unsupported multibase prefix", () => {
        assert.throws(() => parseCID("fnotavalidcid"), /Unsupported CID multibase prefix/);
    });
});

// ---------------------------------------------------------------------------
// isCID
// ---------------------------------------------------------------------------

describe("isCID", () => {
    it("returns true for QmXXX (CIDv0 pattern)", () => {
        assert.equal(isCID("Qm" + "a".repeat(44)), true);
    });

    it("returns true for bafyXXX (CIDv1 base32 pattern)", () => {
        assert.equal(isCID("bafy" + "a".repeat(50)), true);
    });

    it("returns false for empty string", () => {
        assert.equal(isCID(""), false);
    });

    it("returns false for short strings", () => {
        assert.equal(isCID("Qm"), false);
    });

    it("returns false for random text", () => {
        assert.equal(isCID("not a cid at all"), false);
    });

    it("returns true for z-prefixed CIDv1", () => {
        assert.equal(isCID("z" + "A".repeat(44)), true);
    });
});

// ---------------------------------------------------------------------------
// cidToBase32
// ---------------------------------------------------------------------------

describe("cidToBase32", () => {
    it("converts a CIDv1 to base32", () => {
        const digest = new Uint8Array(32).fill(0x42);
        const original = buildCIDv1(0x0129, 0x12, digest);
        const converted = cidToBase32(original);
        assert.ok(converted.startsWith("b"));
        // Should round-trip through parse
        const parsed = parseCID(converted);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.codec, 0x0129);
        assert.deepEqual(parsed.digest, digest);
    });

    it("is idempotent", () => {
        const digest = new Uint8Array(32).fill(0x77);
        const cid = buildCIDv1(0x0129, 0x12, digest);
        const once = cidToBase32(cid);
        const twice = cidToBase32(once);
        assert.equal(once, twice);
    });
});
