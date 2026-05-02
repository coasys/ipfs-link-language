/**
 * Tests for SDNA pattern detection (pure logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectPattern } from "../src/sdna.js";
import type { DetectedPattern } from "../src/sdna.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_CHAT_PREDICATES = ["flux://has_message", "sioc://content_of"];

function makeLink(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
            ...overrides,
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// detectPattern
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    // Chat message patterns
    describe("chat-message detection", () => {
        it("detects flux://has_message as chat-message", () => {
            const link = makeLink({ predicate: "flux://has_message" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "channel://main");
            assert.equal(result.contentUri, "expr://msg-001");
        });

        it("detects sioc://content_of as chat-message", () => {
            const link = makeLink({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("detects custom chat predicates", () => {
            const link = makeLink({ predicate: "custom://chat-message" });
            const result = detectPattern(link, ["custom://chat-message"]);
            assert.equal(result.type, "chat-message");
        });

        it("does not detect chat-message for empty chatPredicates", () => {
            const link = makeLink({ predicate: "flux://has_message" });
            const result = detectPattern(link, []);
            assert.equal(result.type, "unknown");
        });
    });

    // Reply patterns
    describe("reply detection", () => {
        it("detects flux://has_reply as reply", () => {
            const link = makeLink({
                source: "expr://parent-msg",
                target: "expr://reply-msg",
                predicate: "flux://has_reply",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
            assert.equal(result.parentUri, "expr://parent-msg");
            assert.equal(result.contentUri, "expr://reply-msg");
        });

        it("detects sioc://reply_of as reply", () => {
            const link = makeLink({
                source: "expr://parent",
                target: "expr://reply",
                predicate: "sioc://reply_of",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    // Mention patterns
    describe("mention detection", () => {
        it("detects predicate containing 'mention'", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "did:key:z6MkAlice",
                predicate: "flux://has_mention",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
            assert.equal(result.mentionedAgent, "did:key:z6MkAlice");
        });

        it("detects 'mention' case-insensitively", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "did:key:z6MkBob",
                predicate: "custom://HasMention",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });

        it("detects partial 'mention' in predicate", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "did:key:z6MkCarol",
                predicate: "app://user_mentioned",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });
    });

    // Reaction patterns
    describe("reaction detection", () => {
        it("detects flux://has_reaction as reaction", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "👍",
                predicate: "flux://has_reaction",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
            assert.equal(result.contentUri, "👍");
        });

        it("detects emoji://reaction as reaction", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "❤️",
                predicate: "emoji://reaction",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
        });
    });

    // Content patterns
    describe("content detection", () => {
        it("detects sioc://content_of as content when NOT in chatPredicates", () => {
            const link = makeLink({
                source: "blog://post-1",
                target: "expr://article-body",
                predicate: "sioc://content_of",
            });
            const result = detectPattern(link, ["flux://has_message"]);
            assert.equal(result.type, "content");
            assert.equal(result.contentUri, "expr://article-body");
        });
    });

    // Priority
    describe("priority ordering", () => {
        it("chat predicate takes priority over content_of detection", () => {
            const link = makeLink({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("reply predicate is detected when not in chatPredicates", () => {
            const link = makeLink({ predicate: "flux://has_reply" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    // Edge cases
    describe("edge cases", () => {
        it("returns unknown for empty predicate", () => {
            const link = makeLink({ predicate: "" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "unknown");
        });

        it("returns unknown for undefined predicate", () => {
            const link = makeLink({ predicate: undefined });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "unknown");
        });

        it("returns unknown for unrecognized predicate", () => {
            const link = makeLink({ predicate: "custom://unknown-action" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "unknown");
        });

        it("handles link with empty source and target", () => {
            const link = makeLink({
                source: "",
                target: "",
                predicate: "flux://has_message",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "");
            assert.equal(result.contentUri, "");
        });
    });
});
