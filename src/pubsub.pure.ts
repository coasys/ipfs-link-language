/**
 * Pure PubSub functions — zero runtime deps.
 *
 * Builds URL strings, encodes topics, constructs message payloads,
 * and parses PubSub API responses for the Kubo HTTP API.
 * The actual HTTP calls are made by the transport layer.
 */

import type { DID } from "./types.js";

// ---------------------------------------------------------------------------
// Topic multibase encoding (Kubo 0.41+)
// ---------------------------------------------------------------------------

/**
 * Encode a topic string as multibase base64url (no-padding) for Kubo 0.41+.
 *
 * The `u` prefix indicates base64url-no-pad encoding per the multibase spec.
 * Example: "test-topic" → "udGVzdC10b3BpYw"
 */
export function encodeTopicMultibase(topic: string): string {
    const bytes = new TextEncoder().encode(topic);
    let b64 = "";
    for (let i = 0; i < bytes.length; i++) {
        b64 += String.fromCharCode(bytes[i]);
    }
    b64 = btoa(b64);
    // Convert standard base64 to base64url (no padding)
    b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return "u" + b64;
}

// ---------------------------------------------------------------------------
// Topic builders
// ---------------------------------------------------------------------------

/**
 * Build the presence topic for a neighbourhood.
 */
export function presenceTopic(neighbourhoodUrl: string): string {
    return `ad4m/${neighbourhoodUrl}/presence`;
}

/**
 * Build the signal topic for a specific target DID in a neighbourhood.
 */
export function signalTopic(neighbourhoodUrl: string, targetDid: DID): string {
    return `ad4m/${neighbourhoodUrl}/signal/${targetDid}`;
}

/**
 * Build the broadcast topic for a neighbourhood.
 */
export function broadcastTopic(neighbourhoodUrl: string): string {
    return `ad4m/${neighbourhoodUrl}/broadcast`;
}

// ---------------------------------------------------------------------------
// Message payloads
// ---------------------------------------------------------------------------

export interface PresenceMessage {
    type: "presence";
    did: DID;
    status: unknown;
    timestamp: number;
}

export interface SignalMessage {
    type: "signal";
    from: DID;
    payload: unknown;
    timestamp: number;
}

export interface BroadcastMessage {
    type: "broadcast";
    from: DID;
    payload: unknown;
    timestamp: number;
}

export type PubSubMessage = PresenceMessage | SignalMessage | BroadcastMessage;

/**
 * Build a presence heartbeat message payload.
 */
export function buildPresenceMessage(did: DID, status: unknown, timestamp: number): PresenceMessage {
    return { type: "presence", did, status, timestamp };
}

/**
 * Build a signal message payload.
 */
export function buildSignalMessage(fromDid: DID, payload: unknown, timestamp: number): SignalMessage {
    return { type: "signal", from: fromDid, payload, timestamp };
}

/**
 * Build a broadcast message payload.
 */
export function buildBroadcastMessage(fromDid: DID, payload: unknown, timestamp: number): BroadcastMessage {
    return { type: "broadcast", from: fromDid, payload, timestamp };
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Build the URL for pubsub/pub.
 * Topic must already be multibase-encoded.
 */
export function pubsubPubUrl(apiUrl: string, encodedTopic: string): string {
    return `${apiUrl}/api/v0/pubsub/pub?arg=${encodedTopic}`;
}

/**
 * Build the URL for pubsub/peers.
 * Topic must already be multibase-encoded.
 */
export function pubsubPeersUrl(apiUrl: string, encodedTopic: string): string {
    return `${apiUrl}/api/v0/pubsub/peers?arg=${encodedTopic}`;
}

/**
 * Build the URL for pubsub/ls.
 */
export function pubsubLsUrl(apiUrl: string): string {
    return `${apiUrl}/api/v0/pubsub/ls`;
}

// ---------------------------------------------------------------------------
// Request body builders
// ---------------------------------------------------------------------------

const PUBSUB_BOUNDARY = "ad4m-pubsub-boundary";

/**
 * Build a multipart form body for pubsub/pub.
 * Returns { body, contentType }.
 */
export function buildPubsubPublishBody(messageData: string): {
    body: string;
    contentType: string;
} {
    const body = [
        `--${PUBSUB_BOUNDARY}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="data"\r\n`,
        `Content-Type: application/octet-stream\r\n`,
        `\r\n`,
        messageData,
        `\r\n`,
        `--${PUBSUB_BOUNDARY}--\r\n`,
    ].join("");

    return {
        body,
        contentType: `multipart/form-data; boundary=${PUBSUB_BOUNDARY}`,
    };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse a pubsub/peers response.
 * Returns array of PeerID strings.
 *
 * Response format: {"Strings": ["12D3KooW...", ...]} or {"Strings": null}
 */
export function parsePubsubPeersResponse(body: string): string[] {
    const result = JSON.parse(body);
    return result.Strings || [];
}

/**
 * Parse a pubsub/ls response.
 * Returns array of topic strings (multibase-encoded).
 *
 * Response format: {"Strings": ["utopic1", ...]} or {"Strings": null}
 */
export function parsePubsubLsResponse(body: string): string[] {
    const result = JSON.parse(body);
    return result.Strings || [];
}

// ---------------------------------------------------------------------------
// Presence tracking helpers (pure logic)
// ---------------------------------------------------------------------------

/** How long (ms) before a heartbeat is considered stale. */
export const PRESENCE_TTL_MS = 30_000;

export interface PresenceRecord {
    did: DID;
    peerId?: string;
    status: unknown;
    timestamp: number;
}

/**
 * Determine which agents are online based on presence records and a TTL.
 */
export function filterOnlineAgents(
    records: PresenceRecord[],
    now: number,
    ttlMs: number = PRESENCE_TTL_MS,
): PresenceRecord[] {
    const cutoff = now - ttlMs;
    return records.filter(r => r.timestamp > cutoff);
}

/**
 * Merge a new presence record into an existing list.
 * Replaces the record for the same DID, or appends if new.
 */
export function mergePresenceRecord(
    records: PresenceRecord[],
    incoming: PresenceRecord,
): PresenceRecord[] {
    const existing = records.findIndex(r => r.did === incoming.did);
    if (existing >= 0) {
        const updated = [...records];
        updated[existing] = incoming;
        return updated;
    }
    return [...records, incoming];
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

const PRESENCE_PREFIX = "telepresence/presence/";
const PEER_MAP_PREFIX = "telepresence/peermap/";
const SIGNAL_CB_KEY = "telepresence/signal-callback";

/**
 * Storage key for a DID's presence record.
 */
export function presenceStorageKey(did: DID): string {
    return `${PRESENCE_PREFIX}${did}`;
}

/**
 * Storage key for a PeerID → DID mapping.
 */
export function peerMapStorageKey(peerId: string): string {
    return `${PEER_MAP_PREFIX}${peerId}`;
}

/**
 * Prefix for listing all presence records.
 */
export function presenceStoragePrefix(): string {
    return PRESENCE_PREFIX;
}

/**
 * Prefix for listing all peer map entries.
 */
export function peerMapStoragePrefix(): string {
    return PEER_MAP_PREFIX;
}

/**
 * Storage key for the signal callback reference flag.
 */
export function signalCallbackKey(): string {
    return SIGNAL_CB_KEY;
}
