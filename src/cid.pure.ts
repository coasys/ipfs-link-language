/**
 * Pure CID string handling — zero runtime deps.
 *
 * Provides base58btc and base32lower encoding/decoding, CID string
 * parsing, and conversion utilities. These are pure functions that
 * operate on strings and byte arrays without any ad4m:host dependency.
 *
 * CRITICAL: AD4M's hash() and IPFS CIDs are NOT interchangeable.
 * - AD4M: SHA-256(data) → base58btc with "Qm" prefix
 * - IPFS CIDv0: multihash(0x12, 0x20, SHA-256(data)) → base58btc
 * - IPFS CIDv1: multibase + version + multicodec + multihash
 */

// ---------------------------------------------------------------------------
// Base58btc alphabet (Bitcoin)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode a Uint8Array as base58btc.
 */
export function base58btcEncode(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";

    // Count leading zeros
    let leadingZeros = 0;
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
        leadingZeros++;
    }

    // Convert to base58
    // Use BigInt for precise arithmetic
    let value = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
        value = value * BigInt(256) + BigInt(bytes[i]);
    }

    let result = "";
    while (value > BigInt(0)) {
        const remainder = Number(value % BigInt(58));
        value = value / BigInt(58);
        result = BASE58_ALPHABET[remainder] + result;
    }

    // Add leading '1's for each leading zero byte
    for (let i = 0; i < leadingZeros; i++) {
        result = "1" + result;
    }

    return result;
}

/**
 * Decode a base58btc string to Uint8Array.
 */
export function base58btcDecode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0);

    // Count leading '1's
    let leadingOnes = 0;
    for (let i = 0; i < str.length && str[i] === "1"; i++) {
        leadingOnes++;
    }

    // Convert from base58
    let value = BigInt(0);
    for (let i = 0; i < str.length; i++) {
        const idx = BASE58_ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error(`Invalid base58 character: ${str[i]}`);
        value = value * BigInt(58) + BigInt(idx);
    }

    // Convert BigInt to bytes
    const hexStr = value === BigInt(0) ? "" : value.toString(16);
    const paddedHex = hexStr.length % 2 === 0 ? hexStr : "0" + hexStr;
    const byteLength = paddedHex.length / 2;

    const result = new Uint8Array(leadingOnes + byteLength);
    // Leading zeros are already 0 in the Uint8Array
    for (let i = 0; i < byteLength; i++) {
        result[leadingOnes + i] = parseInt(paddedHex.substring(i * 2, i * 2 + 2), 16);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Base32lower (RFC 4648, no padding)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encode a Uint8Array as base32lower (RFC 4648, no padding).
 */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let buffer = 0;
    let result = "";

    for (let i = 0; i < bytes.length; i++) {
        buffer = (buffer << 8) | bytes[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
        }
    }

    if (bits > 0) {
        result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
    }

    return result;
}

/**
 * Decode a base32lower string to Uint8Array.
 */
export function base32Decode(str: string): Uint8Array {
    const lower = str.toLowerCase().replace(/=+$/, "");
    let bits = 0;
    let buffer = 0;
    const result: number[] = [];

    for (let i = 0; i < lower.length; i++) {
        const idx = BASE32_ALPHABET.indexOf(lower[i]);
        if (idx < 0) throw new Error(`Invalid base32 character: ${lower[i]}`);
        buffer = (buffer << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            result.push((buffer >> bits) & 0xff);
        }
    }

    return new Uint8Array(result);
}

// ---------------------------------------------------------------------------
// CID parsing
// ---------------------------------------------------------------------------

/** Parsed CID components. */
export interface ParsedCID {
    /** CID version: 0 or 1 */
    version: 0 | 1;
    /** Multicodec code (0x70 = dag-pb, 0x71 = dag-cbor, 0x0129 = dag-json, 0x55 = raw) */
    codec: number;
    /** Multihash function code (0x12 = sha2-256) */
    hashFunction: number;
    /** Hash digest length */
    hashLength: number;
    /** Raw hash digest bytes */
    digest: Uint8Array;
    /** Original CID string */
    original: string;
}

/**
 * Read a varint from bytes at the given offset.
 * Returns [value, bytesRead].
 */
function readVarint(bytes: Uint8Array, offset: number): [number, number] {
    let value = 0;
    let shift = 0;
    let pos = offset;
    while (pos < bytes.length) {
        const byte = bytes[pos];
        value |= (byte & 0x7f) << shift;
        pos++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [value, pos - offset];
}

/**
 * Write a varint to a byte array. Returns the bytes.
 */
export function writeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return new Uint8Array(bytes);
}

/**
 * Parse a CID string into its components.
 * Handles both CIDv0 (Qm...) and CIDv1 (b... base32 or z... base58btc).
 */
export function parseCID(cidStr: string): ParsedCID {
    if (cidStr.startsWith("Qm")) {
        // CIDv0: base58btc-encoded multihash (SHA-256)
        const bytes = base58btcDecode(cidStr);
        // multihash: varint(hash-fn) + varint(digest-size) + digest
        const [hashFn, hashFnLen] = readVarint(bytes, 0);
        const [hashLen, hashLenLen] = readVarint(bytes, hashFnLen);
        const digest = bytes.slice(hashFnLen + hashLenLen);
        return {
            version: 0,
            codec: 0x70, // dag-pb
            hashFunction: hashFn,
            hashLength: hashLen,
            digest,
            original: cidStr,
        };
    }

    // CIDv1: multibase prefix + version + codec + multihash
    let rawBytes: Uint8Array;
    if (cidStr.startsWith("b")) {
        // base32lower
        rawBytes = base32Decode(cidStr.substring(1));
    } else if (cidStr.startsWith("z")) {
        // base58btc
        rawBytes = base58btcDecode(cidStr.substring(1));
    } else {
        throw new Error(`Unsupported CID multibase prefix: ${cidStr[0]}`);
    }

    let offset = 0;
    const [version, vLen] = readVarint(rawBytes, offset);
    offset += vLen;
    const [codec, cLen] = readVarint(rawBytes, offset);
    offset += cLen;
    const [hashFn, hfLen] = readVarint(rawBytes, offset);
    offset += hfLen;
    const [hashLen, hlLen] = readVarint(rawBytes, offset);
    offset += hlLen;
    const digest = rawBytes.slice(offset, offset + hashLen);

    return {
        version: version as 0 | 1,
        codec,
        hashFunction: hashFn,
        hashLength: hashLen,
        digest,
        original: cidStr,
    };
}

/**
 * Build a CIDv1 string in base32lower from components.
 */
export function buildCIDv1(codec: number, hashFunction: number, digest: Uint8Array): string {
    const version = writeVarint(1);
    const codecBytes = writeVarint(codec);
    const hashFnBytes = writeVarint(hashFunction);
    const hashLenBytes = writeVarint(digest.length);

    const totalLen = version.length + codecBytes.length + hashFnBytes.length + hashLenBytes.length + digest.length;
    const raw = new Uint8Array(totalLen);
    let offset = 0;
    raw.set(version, offset); offset += version.length;
    raw.set(codecBytes, offset); offset += codecBytes.length;
    raw.set(hashFnBytes, offset); offset += hashFnBytes.length;
    raw.set(hashLenBytes, offset); offset += hashLenBytes.length;
    raw.set(digest, offset);

    return "b" + base32Encode(raw);
}

/**
 * Check if a string looks like a valid CID.
 */
export function isCID(str: string): boolean {
    if (!str || str.length < 2) return false;
    // CIDv0
    if (str.startsWith("Qm") && str.length >= 44) return true;
    // CIDv1 base32
    if (str.startsWith("bafy") && str.length >= 50) return true;
    // CIDv1 base58btc
    if (str.startsWith("z") && str.length >= 40) return true;
    return false;
}

/**
 * Convert a CID string between base encodings.
 * Always returns base32lower CIDv1.
 */
export function cidToBase32(cidStr: string): string {
    const parsed = parseCID(cidStr);
    if (parsed.version === 0) {
        // Upgrade CIDv0 to CIDv1 with dag-pb codec
        return buildCIDv1(0x70, parsed.hashFunction, parsed.digest);
    }
    return buildCIDv1(parsed.codec, parsed.hashFunction, parsed.digest);
}
