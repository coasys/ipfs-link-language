/**
 * Tests for IPFS HTTP API request builders (pure logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    dagPutUrl,
    dagGetUrl,
    namePublishUrl,
    nameResolveUrl,
    pinAddUrl,
    pinRmUrl,
    pinLsUrl,
    keyGenUrl,
    keyListUrl,
    dagExportUrl,
    dagImportUrl,
    parseDagPutResponse,
    parseNameResolveResponse,
    parseNamePublishResponse,
    parsePinAddResponse,
    parseKeyGenResponse,
    parseKeyListResponse,
} from "../src/ipfs-api.pure.js";

const API = "http://localhost:5001";

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

describe("dagPutUrl", () => {
    it("builds correct URL with defaults", () => {
        const url = dagPutUrl(API);
        assert.ok(url.includes("/api/v0/dag/put"));
        assert.ok(url.includes("store-codec=dag-json"));
        assert.ok(url.includes("input-codec=dag-json"));
        assert.ok(url.includes("pin=true"));
    });

    it("respects pin=false", () => {
        const url = dagPutUrl(API, false);
        assert.ok(url.includes("pin=false"));
    });

    it("respects custom codec", () => {
        const url = dagPutUrl(API, true, "dag-cbor");
        assert.ok(url.includes("store-codec=dag-cbor"));
    });
});

describe("dagGetUrl", () => {
    it("builds correct URL", () => {
        const url = dagGetUrl(API, "bafyreiabc");
        assert.ok(url.includes("/api/v0/dag/get"));
        assert.ok(url.includes("arg=bafyreiabc"));
        assert.ok(url.includes("output-codec=dag-json"));
    });

    it("encodes CID in URL", () => {
        const url = dagGetUrl(API, "bafy/special");
        assert.ok(url.includes(encodeURIComponent("bafy/special")));
    });
});

describe("namePublishUrl", () => {
    it("builds basic URL", () => {
        const url = namePublishUrl(API, "bafyreiabc");
        assert.ok(url.includes("/api/v0/name/publish"));
        assert.ok(url.includes("arg=bafyreiabc"));
    });

    it("includes key name", () => {
        const url = namePublishUrl(API, "bafyreiabc", "mykey");
        assert.ok(url.includes("key=mykey"));
    });

    it("includes TTL", () => {
        const url = namePublishUrl(API, "bafyreiabc", undefined, 60);
        assert.ok(url.includes("ttl=60s"));
    });

    it("includes all params", () => {
        const url = namePublishUrl(API, "bafyreiabc", "mykey", 120);
        assert.ok(url.includes("key=mykey"));
        assert.ok(url.includes("ttl=120s"));
    });
});

describe("nameResolveUrl", () => {
    it("builds correct URL", () => {
        const url = nameResolveUrl(API, "k51qzi5uqu5dl");
        assert.ok(url.includes("/api/v0/name/resolve"));
        assert.ok(url.includes("arg=k51qzi5uqu5dl"));
    });
});

describe("pinAddUrl", () => {
    it("builds correct URL with defaults", () => {
        const url = pinAddUrl(API, "bafyreiabc");
        assert.ok(url.includes("/api/v0/pin/add"));
        assert.ok(url.includes("arg=bafyreiabc"));
        assert.ok(url.includes("recursive=true"));
    });

    it("respects recursive=false", () => {
        const url = pinAddUrl(API, "bafyreiabc", false);
        assert.ok(url.includes("recursive=false"));
    });
});

describe("pinRmUrl", () => {
    it("builds correct URL", () => {
        const url = pinRmUrl(API, "bafyreiabc");
        assert.ok(url.includes("/api/v0/pin/rm"));
        assert.ok(url.includes("arg=bafyreiabc"));
    });
});

describe("pinLsUrl", () => {
    it("builds correct URL", () => {
        const url = pinLsUrl(API);
        assert.ok(url.includes("/api/v0/pin/ls"));
    });
});

describe("keyGenUrl", () => {
    it("builds correct URL with defaults", () => {
        const url = keyGenUrl(API, "mykey");
        assert.ok(url.includes("/api/v0/key/gen"));
        assert.ok(url.includes("arg=mykey"));
        assert.ok(url.includes("type=ed25519"));
    });

    it("respects custom type", () => {
        const url = keyGenUrl(API, "mykey", "rsa");
        assert.ok(url.includes("type=rsa"));
    });
});

describe("keyListUrl", () => {
    it("builds correct URL", () => {
        const url = keyListUrl(API);
        assert.ok(url.includes("/api/v0/key/list"));
    });
});

describe("dagExportUrl", () => {
    it("builds correct URL", () => {
        const url = dagExportUrl(API, "bafyreiabc");
        assert.ok(url.includes("/api/v0/dag/export"));
        assert.ok(url.includes("arg=bafyreiabc"));
    });
});

describe("dagImportUrl", () => {
    it("builds correct URL", () => {
        const url = dagImportUrl(API);
        assert.ok(url.includes("/api/v0/dag/import"));
    });
});

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

describe("parseDagPutResponse", () => {
    it("parses Cid with / key", () => {
        const body = JSON.stringify({ Cid: { "/": "bafyreiabc123" } });
        assert.equal(parseDagPutResponse(body), "bafyreiabc123");
    });

    it("parses plain Cid", () => {
        const body = JSON.stringify({ Cid: "bafyreiabc123" });
        assert.equal(parseDagPutResponse(body), "bafyreiabc123");
    });

    it("parses Hash key", () => {
        const body = JSON.stringify({ Hash: "QmXyz123" });
        assert.equal(parseDagPutResponse(body), "QmXyz123");
    });

    it("parses Key key", () => {
        const body = JSON.stringify({ Key: "bafydef456" });
        assert.equal(parseDagPutResponse(body), "bafydef456");
    });

    it("throws when no CID found", () => {
        assert.throws(() => parseDagPutResponse("{}"), /no CID/);
    });
});

describe("parseNameResolveResponse", () => {
    it("strips /ipfs/ prefix", () => {
        const body = JSON.stringify({ Path: "/ipfs/bafyreiabc123" });
        assert.equal(parseNameResolveResponse(body), "bafyreiabc123");
    });

    it("returns raw path without /ipfs/ prefix", () => {
        const body = JSON.stringify({ Path: "bafyreiabc123" });
        assert.equal(parseNameResolveResponse(body), "bafyreiabc123");
    });

    it("returns empty string for empty response", () => {
        const body = JSON.stringify({});
        assert.equal(parseNameResolveResponse(body), "");
    });
});

describe("parseNamePublishResponse", () => {
    it("parses name and value", () => {
        const body = JSON.stringify({ Name: "k51qzi5uqu5dl", Value: "/ipfs/bafy123" });
        const result = parseNamePublishResponse(body);
        assert.equal(result.name, "k51qzi5uqu5dl");
        assert.equal(result.value, "/ipfs/bafy123");
    });

    it("handles missing fields", () => {
        const result = parseNamePublishResponse("{}");
        assert.equal(result.name, "");
        assert.equal(result.value, "");
    });
});

describe("parsePinAddResponse", () => {
    it("parses Pins array", () => {
        const body = JSON.stringify({ Pins: ["bafyabc", "bafydef"] });
        const result = parsePinAddResponse(body);
        assert.deepEqual(result, ["bafyabc", "bafydef"]);
    });

    it("falls back to Hash", () => {
        const body = JSON.stringify({ Hash: "bafyabc" });
        const result = parsePinAddResponse(body);
        assert.deepEqual(result, ["bafyabc"]);
    });
});

describe("parseKeyGenResponse", () => {
    it("parses name and id", () => {
        const body = JSON.stringify({ Name: "mykey", Id: "k51qzi5uqu5dl" });
        const result = parseKeyGenResponse(body);
        assert.equal(result.name, "mykey");
        assert.equal(result.id, "k51qzi5uqu5dl");
    });

    it("handles missing fields", () => {
        const result = parseKeyGenResponse("{}");
        assert.equal(result.name, "");
        assert.equal(result.id, "");
    });
});

describe("parseKeyListResponse", () => {
    it("parses key list", () => {
        const body = JSON.stringify({
            Keys: [
                { Name: "self", Id: "k51abc" },
                { Name: "mykey", Id: "k51def" },
            ],
        });
        const result = parseKeyListResponse(body);
        assert.equal(result.length, 2);
        assert.equal(result[0].name, "self");
        assert.equal(result[1].name, "mykey");
    });

    it("handles empty list", () => {
        const body = JSON.stringify({ Keys: [] });
        const result = parseKeyListResponse(body);
        assert.deepEqual(result, []);
    });

    it("handles missing Keys", () => {
        const result = parseKeyListResponse("{}");
        assert.deepEqual(result, []);
    });
});
