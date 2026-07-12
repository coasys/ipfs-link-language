/**
 * PubSub client — uses getTransport() for HTTP calls and getStorage() for KV.
 *
 * Provides high-level methods for IPFS Kubo PubSub-based telepresence:
 * - Publish presence heartbeats
 * - Query online peers
 * - Send signals and broadcasts
 * - Register signal callbacks
 *
 * No ad4m:host imports — uses injected transport and storage adapters.
 */

import { getTransport } from "./adapters.js";
import { getStorage } from "./adapters.js";
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

/**
 * Build the head-announcement topic for a neighbourhood. Agents announce their
 * per-agent IPNS name + current head CID here so peers can discover the head
 * frontier.
 */
export function headTopic(neighbourhoodUrl: string): string {
    return `ad4m/${neighbourhoodUrl}/heads`;
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

/**
 * A head announcement: an agent tells the neighbourhood its own IPNS name and
 * its current head commit CID, so peers can (a) resolve its IPNS name later
 * and (b) fast-path directly to the announced head CID.
 */
export interface HeadAnnounceMessage {
    type: "head";
    did: DID;
    ipnsName: string;
    head: string;
    timestamp: number;
}

export type PubSubMessage =
    | PresenceMessage
    | SignalMessage
    | BroadcastMessage
    | HeadAnnounceMessage;

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

/**
 * Build a head-announcement message payload.
 */
export function buildHeadAnnounceMessage(
    did: DID,
    ipnsName: string,
    head: string,
    timestamp: number,
): HeadAnnounceMessage {
    return { type: "head", did, ipnsName, head, timestamp };
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
const PEER_IPNS_PREFIX = "sync/peer-ipns/";

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


// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _signalCallback: ((payload: PubSubMessage) => void) | null = null;

// ---------------------------------------------------------------------------
// Core publish helper
// ---------------------------------------------------------------------------

/**
 * Publish a message to a PubSub topic.
 */
async function publishMessage(
    apiUrl: string,
    topic: string,
    message: PubSubMessage,
): Promise<void> {
    const encodedTopic = encodeTopicMultibase(topic);
    const url = pubsubPubUrl(apiUrl, encodedTopic);
    const messageData = JSON.stringify(message);
    const { body, contentType } = buildPubsubPublishBody(messageData);

    const response = await getTransport().fetch(
        url,
        "POST",
        { "Content-Type": contentType },
        body,
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`pubsub/pub failed: HTTP ${response.status} — ${response.body}`);
    }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * Publish a presence heartbeat and store the record locally.
 */
export async function publishPresence(
    apiUrl: string,
    neighbourhoodUrl: string,
    agentDid: DID,
    status: unknown,
): Promise<void> {
    const now = Date.now();
    const topic = presenceTopic(neighbourhoodUrl);
    const message = buildPresenceMessage(agentDid, status, now);

    // Publish to PubSub
    await publishMessage(apiUrl, topic, message);

    // Store locally so other methods can correlate
    const record: PresenceRecord = {
        did: agentDid,
        status,
        timestamp: now,
    };
    const storage = getStorage();
    storage.put(presenceStorageKey(agentDid), JSON.stringify(record));
}

/**
 * Query online agents by checking pubsub/peers and local presence records.
 *
 * Strategy:
 * 1. Query peers on the presence topic to see who's connected
 * 2. Read local presence records from storage
 * 3. Filter to records within TTL
 * 4. If signal callback is registered, this is also when we'd drain queued signals
 */
export async function queryOnlineAgents(
    apiUrl: string,
    neighbourhoodUrl: string,
): Promise<PresenceRecord[]> {
    const storage = getStorage();

    // 1. Query peers on the presence topic
    const topic = presenceTopic(neighbourhoodUrl);
    const encodedTopic = encodeTopicMultibase(topic);
    const peersUrl = pubsubPeersUrl(apiUrl, encodedTopic);

    let peerIds: string[] = [];
    try {
        const response = await getTransport().fetch(peersUrl, "POST", {}, "");
        if (response.status >= 200 && response.status < 300) {
            peerIds = parsePubsubPeersResponse(response.body);
        }
    } catch {
        // If peers endpoint fails, fall back to local records only
    }

    // 2. Note the active peer IDs (for correlation)
    // PeerIDs tell us who's subscribed to the topic but not their DID.
    // We store PeerID → DID mappings as they come in via heartbeats.

    // 3. Read all local presence records
    const presenceKeys = storage.listKeys(presenceStoragePrefix());
    const now = Date.now();
    let records: PresenceRecord[] = [];

    for (const key of presenceKeys) {
        const raw = storage.get(key);
        if (!raw) continue;
        try {
            const record: PresenceRecord = JSON.parse(raw);
            records.push(record);
        } catch {
            // Skip malformed records
        }
    }

    // 4. Also include peer-mapped agents that are connected but may not have
    //    a local presence record yet
    for (const peerId of peerIds) {
        const didRaw = storage.get(peerMapStorageKey(peerId));
        if (didRaw) {
            const did = didRaw;
            const existingIdx = records.findIndex(r => r.did === did);
            if (existingIdx < 0) {
                // Peer is connected but no heartbeat record — add with current time
                records.push({ did, peerId, status: "connected", timestamp: now });
            } else if (records[existingIdx]) {
                // Update peerId on existing record
                records[existingIdx] = { ...records[existingIdx], peerId };
            }
        }
    }

    // 5. Filter to online agents (within TTL)
    return filterOnlineAgents(records, now, PRESENCE_TTL_MS);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Send a targeted signal to a specific agent.
 */
export async function sendSignal(
    apiUrl: string,
    neighbourhoodUrl: string,
    fromDid: DID,
    remoteDid: DID,
    payload: unknown,
): Promise<object> {
    const now = Date.now();
    const topic = signalTopic(neighbourhoodUrl, remoteDid);
    const message = buildSignalMessage(fromDid, payload, now);

    await publishMessage(apiUrl, topic, message);

    return { status: "sent", topic, timestamp: now };
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

/**
 * Send a broadcast message to all agents in the neighbourhood.
 */
export async function sendBroadcast(
    apiUrl: string,
    neighbourhoodUrl: string,
    fromDid: DID,
    payload: unknown,
): Promise<object> {
    const now = Date.now();
    const topic = broadcastTopic(neighbourhoodUrl);
    const message = buildBroadcastMessage(fromDid, payload, now);

    await publishMessage(apiUrl, topic, message);

    return { status: "sent", topic, timestamp: now };
}

// ---------------------------------------------------------------------------
// Signal callback
// ---------------------------------------------------------------------------

/**
 * Register a callback for incoming signals.
 * Signals will be delivered when they arrive via polling or PubSub.
 */
export function registerSignalCallback(
    callback: (payload: PubSubMessage) => void,
): void {
    _signalCallback = callback;
}

/**
 * Get the currently registered signal callback (for testing).
 */
export function getSignalCallback(): ((payload: PubSubMessage) => void) | null {
    return _signalCallback;
}

/**
 * Deliver a signal to the registered callback, if any.
 */
export function deliverSignal(payload: PubSubMessage): void {
    if (_signalCallback) {
        _signalCallback(payload);
    }
}

/**
 * Clear the signal callback (for teardown).
 */
export function clearSignalCallback(): void {
    _signalCallback = null;
}

// ---------------------------------------------------------------------------
// PeerID ↔ DID mapping
// ---------------------------------------------------------------------------

/**
 * Store a PeerID → DID mapping.
 */
export function storePeerMapping(peerId: string, did: DID): void {
    const storage = getStorage();
    storage.put(peerMapStorageKey(peerId), did);
}

/**
 * Look up a DID by PeerID.
 */
export function lookupPeerDid(peerId: string): DID | null {
    const storage = getStorage();
    return storage.get(peerMapStorageKey(peerId));
}

/**
 * Store a presence record from an incoming heartbeat.
 */
export function storePresenceRecord(record: PresenceRecord): void {
    const storage = getStorage();
    storage.put(presenceStorageKey(record.did), JSON.stringify(record));
}

// ---------------------------------------------------------------------------
// Head announcement (per-agent IPNS head discovery)
// ---------------------------------------------------------------------------

/**
 * Storage key for a peer DID → IPNS-name mapping.
 */
export function peerIpnsStorageKey(did: DID): string {
    return `${PEER_IPNS_PREFIX}${did}`;
}

/**
 * Prefix for listing all known peer IPNS names.
 */
export function peerIpnsStoragePrefix(): string {
    return PEER_IPNS_PREFIX;
}

/**
 * Record a peer's IPNS name (learned from a head announcement).
 */
export function storePeerIpnsName(did: DID, ipnsName: string): void {
    if (!did || !ipnsName) return;
    getStorage().put(peerIpnsStorageKey(did), ipnsName);
}

/**
 * List all known peer IPNS names.
 */
export function listPeerIpnsNames(): string[] {
    const storage = getStorage();
    const keys = storage.listKeys(peerIpnsStoragePrefix());
    const out: string[] = [];
    for (const k of keys) {
        const name = storage.get(k);
        if (name) out.push(name);
    }
    return out;
}

/**
 * Publish this agent's head announcement (its IPNS name + current head CID) to
 * the neighbourhood head topic.
 */
export async function announceHead(
    apiUrl: string,
    neighbourhoodUrl: string,
    did: DID,
    ipnsName: string,
    head: string,
): Promise<void> {
    const message = buildHeadAnnounceMessage(did, ipnsName, head, Date.now());
    await publishMessage(apiUrl, headTopic(neighbourhoodUrl), message);
}

/**
 * Type guard for a head-announcement message.
 */
export function isHeadAnnounceMessage(msg: unknown): msg is HeadAnnounceMessage {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === "head" &&
        typeof m.did === "string" &&
        typeof m.ipnsName === "string" &&
        typeof m.head === "string"
    );
}

/**
 * Handle an incoming head announcement: record the peer's IPNS name so we can
 * resolve it later. Returns the announced {did, ipnsName, head} so the caller
 * can seed the head frontier directly with the announced CID.
 *
 * The caller's own announcements are ignored (matched by `selfDid`).
 */
export function handleHeadAnnounce(
    msg: HeadAnnounceMessage,
    selfDid: DID,
): { did: DID; ipnsName: string; head: string } | null {
    if (!isHeadAnnounceMessage(msg)) return null;
    if (msg.did === selfDid) return null;
    storePeerIpnsName(msg.did, msg.ipnsName);
    return { did: msg.did, ipnsName: msg.ipnsName, head: msg.head };
}
