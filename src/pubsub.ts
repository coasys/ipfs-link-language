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

import { getTransport } from "./transport.js";
import { getStorage } from "./storage-interface.js";
import type { DID } from "./types.js";
import {
    encodeTopicMultibase,
    presenceTopic,
    signalTopic,
    broadcastTopic,
    buildPresenceMessage,
    buildSignalMessage,
    buildBroadcastMessage,
    buildPubsubPublishBody,
    pubsubPubUrl,
    pubsubPeersUrl,
    parsePubsubPeersResponse,
    presenceStorageKey,
    presenceStoragePrefix,
    peerMapStorageKey,
    peerMapStoragePrefix,
    filterOnlineAgents,
    mergePresenceRecord,
    PRESENCE_TTL_MS,
} from "./pubsub.pure.js";
import type { PresenceRecord, PubSubMessage } from "./pubsub.pure.js";

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
