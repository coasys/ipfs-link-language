/**
 * Tests for Settings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { IPFSSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------

describe("parseSettings", () => {
    it("returns defaults for null", () => {
        const s = parseSettings(null);
        assert.deepEqual(s, DEFAULT_SETTINGS);
    });

    it("returns defaults for undefined", () => {
        const s = parseSettings(undefined);
        assert.deepEqual(s, DEFAULT_SETTINGS);
    });

    it("returns defaults for empty string", () => {
        const s = parseSettings("");
        assert.deepEqual(s, DEFAULT_SETTINGS);
    });

    it("returns defaults for invalid JSON", () => {
        const s = parseSettings("not json");
        assert.deepEqual(s, DEFAULT_SETTINGS);
    });

    it("parses syncMode", () => {
        const s = parseSettings(JSON.stringify({ syncMode: "publish-only" }));
        assert.equal(s.syncMode, "publish-only");
    });

    it("defaults invalid syncMode", () => {
        const s = parseSettings(JSON.stringify({ syncMode: "invalid" }));
        assert.equal(s.syncMode, DEFAULT_SETTINGS.syncMode);
    });

    it("parses codec", () => {
        const s = parseSettings(JSON.stringify({ codec: "dag-cbor" }));
        assert.equal(s.codec, "dag-cbor");
    });

    it("defaults invalid codec", () => {
        const s = parseSettings(JSON.stringify({ codec: "invalid" }));
        assert.equal(s.codec, DEFAULT_SETTINGS.codec);
    });

    it("parses ipns settings", () => {
        const s = parseSettings(JSON.stringify({
            ipns: { keyName: "custom-key", ttlSeconds: 120, pollIntervalMs: 60000 },
        }));
        assert.equal(s.ipns.keyName, "custom-key");
        assert.equal(s.ipns.ttlSeconds, 120);
        assert.equal(s.ipns.pollIntervalMs, 60000);
    });

    it("defaults invalid ipns.ttlSeconds", () => {
        const s = parseSettings(JSON.stringify({ ipns: { ttlSeconds: -1 } }));
        assert.equal(s.ipns.ttlSeconds, DEFAULT_SETTINGS.ipns.ttlSeconds);
    });

    it("defaults invalid ipns.pollIntervalMs", () => {
        const s = parseSettings(JSON.stringify({ ipns: { pollIntervalMs: 0 } }));
        assert.equal(s.ipns.pollIntervalMs, DEFAULT_SETTINGS.ipns.pollIntervalMs);
    });

    it("parses pinning settings", () => {
        const s = parseSettings(JSON.stringify({
            pinning: { pinLocal: false, pinRemote: true, remoteApiKey: "key123" },
        }));
        assert.equal(s.pinning.pinLocal, false);
        assert.equal(s.pinning.pinRemote, true);
        assert.equal(s.pinning.remoteApiKey, "key123");
    });

    it("defaults non-boolean pinning.pinLocal", () => {
        const s = parseSettings(JSON.stringify({ pinning: { pinLocal: "yes" } }));
        assert.equal(s.pinning.pinLocal, DEFAULT_SETTINGS.pinning.pinLocal);
    });

    it("parses pubsub settings", () => {
        const s = parseSettings(JSON.stringify({
            pubsub: { enabled: true, topicPrefix: "/custom/prefix/" },
        }));
        assert.equal(s.pubsub.enabled, true);
        assert.equal(s.pubsub.topicPrefix, "/custom/prefix/");
    });

    it("parses dag settings", () => {
        const s = parseSettings(JSON.stringify({
            dag: { hamtBucketSize: 128, includeDiffChain: false },
        }));
        assert.equal(s.dag.hamtBucketSize, 128);
        assert.equal(s.dag.includeDiffChain, false);
    });

    it("defaults invalid dag.hamtBucketSize", () => {
        const s = parseSettings(JSON.stringify({ dag: { hamtBucketSize: -10 } }));
        assert.equal(s.dag.hamtBucketSize, DEFAULT_SETTINGS.dag.hamtBucketSize);
    });

    it("parses dualLanguage settings", () => {
        const s = parseSettings(JSON.stringify({
            dualLanguage: { enabled: true, excludePredicates: ["flux://internal"] },
        }));
        assert.equal(s.dualLanguage.enabled, true);
        assert.deepEqual(s.dualLanguage.excludePredicates, ["flux://internal"]);
    });

    it("defaults non-array excludePredicates", () => {
        const s = parseSettings(JSON.stringify({
            dualLanguage: { excludePredicates: "not-an-array" },
        }));
        assert.deepEqual(s.dualLanguage.excludePredicates, DEFAULT_SETTINGS.dualLanguage.excludePredicates);
    });

    it("parses all settings together", () => {
        const full: IPFSSettings = {
            syncMode: "subscribe-only",
            codec: "dag-cbor",
            ipns: { keyName: "test", ttlSeconds: 300, pollIntervalMs: 10000 },
            pinning: { pinLocal: false, pinRemote: true, remoteApiKey: "abc" },
            pubsub: { enabled: true, topicPrefix: "/test/" },
            dag: { hamtBucketSize: 64, includeDiffChain: false },
            dualLanguage: { enabled: true, excludePredicates: ["a", "b"] },
        };
        const s = parseSettings(JSON.stringify(full));
        assert.equal(s.syncMode, "subscribe-only");
        assert.equal(s.codec, "dag-cbor");
        assert.equal(s.ipns.keyName, "test");
        assert.equal(s.pinning.pinRemote, true);
        assert.equal(s.pubsub.enabled, true);
        assert.equal(s.dag.hamtBucketSize, 64);
        assert.equal(s.dualLanguage.enabled, true);
    });

    it("handles partial settings gracefully", () => {
        const s = parseSettings(JSON.stringify({ syncMode: "bidirectional" }));
        assert.equal(s.syncMode, "bidirectional");
        // All other settings should be defaults
        assert.equal(s.codec, DEFAULT_SETTINGS.codec);
        assert.deepEqual(s.ipns, DEFAULT_SETTINGS.ipns);
        assert.deepEqual(s.pinning, DEFAULT_SETTINGS.pinning);
        assert.deepEqual(s.pubsub, DEFAULT_SETTINGS.pubsub);
        assert.deepEqual(s.dag, DEFAULT_SETTINGS.dag);
        assert.deepEqual(s.dualLanguage, DEFAULT_SETTINGS.dualLanguage);
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_SETTINGS
// ---------------------------------------------------------------------------

describe("DEFAULT_SETTINGS", () => {
    it("has expected syncMode", () => {
        assert.equal(DEFAULT_SETTINGS.syncMode, "bidirectional");
    });

    it("has expected codec", () => {
        assert.equal(DEFAULT_SETTINGS.codec, "dag-json");
    });

    it("has expected ipns defaults", () => {
        assert.equal(DEFAULT_SETTINGS.ipns.keyName, "ad4m-neighbourhood");
        assert.equal(DEFAULT_SETTINGS.ipns.ttlSeconds, 60);
        assert.equal(DEFAULT_SETTINGS.ipns.pollIntervalMs, 30000);
    });

    it("has expected pinning defaults", () => {
        assert.equal(DEFAULT_SETTINGS.pinning.pinLocal, true);
        assert.equal(DEFAULT_SETTINGS.pinning.pinRemote, false);
        assert.equal(DEFAULT_SETTINGS.pinning.remoteApiKey, "");
    });

    it("has expected pubsub defaults", () => {
        assert.equal(DEFAULT_SETTINGS.pubsub.enabled, false);
        assert.equal(DEFAULT_SETTINGS.pubsub.topicPrefix, "/ad4m/neighbourhood/");
    });

    it("has expected dag defaults", () => {
        assert.equal(DEFAULT_SETTINGS.dag.hamtBucketSize, 256);
        assert.equal(DEFAULT_SETTINGS.dag.includeDiffChain, true);
    });

    it("has expected dualLanguage defaults", () => {
        assert.equal(DEFAULT_SETTINGS.dualLanguage.enabled, false);
        assert.deepEqual(DEFAULT_SETTINGS.dualLanguage.excludePredicates, []);
    });
});
