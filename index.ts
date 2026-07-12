/**
 * # IPFS/IPLD Link Language for AD4M
 *
 * Link Language that syncs Perspectives via IPFS content-addressed storage
 * and IPNS mutable pointers. Persists Perspectives as Merkle DAGs on IPFS,
 * providing verifiable, archival, and deduplicated storage.
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Spec: ipfs-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { IPFSSettings } from "./src/settings.js";
import { shouldPublish, linkOriginKey, linkContentHash, isExcludedPredicate } from "./src/translate.js";
import type { LinkOrigin } from "./src/translate.js";
import * as store from "./src/store.js";
import {
    createCommit,
    getHeadCid,
    setHeadCid,
    setPeerHead,
    setSelfIpnsName,
    getSelfIpnsName,
    currentRevisionHash,
} from "./src/perspective-dag.js";
import { syncFromPeers } from "./src/sync.js";
import { ipnsPublish } from "./src/ipfs-api.js";
import { pinCid } from "./src/pinning.js";
import {
    publishPresence,
    queryOnlineAgents,
    sendSignal as pubsubSendSignal,
    sendBroadcast as pubsubSendBroadcast,
    registerSignalCallback as pubsubRegisterSignalCallback,
    clearSignalCallback,
    announceHead,
    storePeerIpnsName,
    listPeerIpnsNames,
    handleHeadAnnounce,
    isHeadAnnounceMessage,
} from "./src/pubsub.js";
import type { PubSubMessage, HeadAnnounceMessage } from "./src/pubsub.js";

// Adapter imports
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §8)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const IPFS_API_URL = "<to-be-filled>";

//!@ad4m-template-variable
const IPFS_GATEWAY_URL = "<to-be-filled>";

//!@ad4m-template-variable
const IPNS_NAME = "<to-be-filled>";

//!@ad4m-template-variable
const PINNING_SERVICE_URL = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_URL = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: IPFSSettings;

// ---------------------------------------------------------------------------
// Head publication — publish our own IPNS head + announce it to peers.
// ---------------------------------------------------------------------------

/**
 * Publish `cid` as this agent's head: update our own per-agent IPNS name and
 * announce it on the neighbourhood head topic so peers can discover it.
 * Best-effort — IPNS publish latency must not block commit/sync.
 */
async function republishHead(cid: string): Promise<void> {
    if (IPNS_NAME !== "<to-be-filled>") {
        try {
            await ipnsPublish(IPFS_API_URL, cid, settings.ipns.keyName, settings.ipns.ttlSeconds);
        } catch (err) {
            console.log(`[ipfs-link-language] IPNS publish failed: ${err}`);
        }
    }
    if (NEIGHBOURHOOD_URL !== "<to-be-filled>") {
        const selfName = getSelfIpnsName() || IPNS_NAME;
        if (selfName && selfName !== "<to-be-filled>") {
            try {
                await announceHead(IPFS_API_URL, NEIGHBOURHOOD_URL, myDid, selfName, cid);
            } catch (err) {
                console.log(`[ipfs-link-language] head announce failed: ${err}`);
            }
        }
    }
}

/**
 * Ingest an incoming head announcement: record the peer's IPNS name and seed
 * its announced head CID directly into the local head frontier, so the next
 * `sync()` converges against it even before IPNS resolution catches up.
 */
function ingestHeadAnnounce(msg: HeadAnnounceMessage): void {
    const info = handleHeadAnnounce(msg, myDid);
    if (info && info.head) {
        setPeerHead(info.did, info.head);
    }
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/ipfs-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        // This agent's OWN per-agent IPNS name (peers resolve this to read our
        // head). Peers publish their own heads under their own names.
        if (IPNS_NAME !== "<to-be-filled>") {
            setSelfIpnsName(IPNS_NAME);
        }

        console.log(`[ipfs-link-language] init: did=${myDid}`);
        console.log(`[ipfs-link-language] IPFS API: ${IPFS_API_URL}`);
        console.log(`[ipfs-link-language] self IPNS name: ${IPNS_NAME}`);
        console.log(`[ipfs-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[ipfs-link-language] codec: ${settings.codec}`);

        // Cold start: if we have no local head yet, seed the frontier from our
        // own IPNS name (in case a previous instance published one) and any
        // peer IPNS names we already know, then converge.
        if (!getHeadCid() && settings.syncMode !== "publish-only") {
            try {
                const peerNames = listPeerIpnsNames();
                const bootstrap = IPNS_NAME !== "<to-be-filled>" ? [IPNS_NAME, ...peerNames] : peerNames;
                if (bootstrap.length > 0) {
                    const diff = await syncFromPeers(IPFS_API_URL, bootstrap, {
                        mergeAuthor: myDid,
                        publishHead: (cid) => republishHead(cid),
                        pin: settings.pinning.pinLocal,
                    });
                    if (diff.additions.length > 0 || diff.removals.length > 0) {
                        console.log(`[ipfs-link-language] initial sync: ${diff.additions.length} additions, ${diff.removals.length} removals`);
                    }
                }
            } catch (err) {
                console.log(`[ipfs-link-language] initial sync failed (may be first peer): ${err}`);
            }
        }
    },

    async teardown() {
        clearSignalCallback();
        myDid = "";
        console.log("[ipfs-link-language] teardown");
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 1. Store links locally
            store.applyDiff(diff);

            // 2. Skip IPFS publishing in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            // 3. Filter links for IPFS publication
            const publishableDiff: PerspectiveDiff = {
                additions: diff.additions.filter(link => {
                    // Check dual-language filter
                    const linkHash = store.hashLink(link);
                    if (!shouldPublish(linkHash, (key) => getStorage().get(key))) {
                        return false;
                    }
                    // Check excluded predicates
                    if (settings.dualLanguage.enabled &&
                        isExcludedPredicate(link.data.predicate, settings.dualLanguage.excludePredicates)) {
                        return false;
                    }
                    return true;
                }),
                removals: diff.removals.filter(link => {
                    const linkHash = store.hashLink(link);
                    return shouldPublish(linkHash, (key) => getStorage().get(key));
                }),
            };

            // 4. Track origins for new native commits
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const storage = getStorage();
                const existing = storage.get(originKey);
                if (existing === "ipfs") {
                    storage.put(originKey, "dual");
                } else if (!existing) {
                    storage.put(originKey, "native");
                }
            }

            // 5. Create IPFS commit if there are publishable changes
            if (publishableDiff.additions.length > 0 || publishableDiff.removals.length > 0) {
                try {
                    const commitCid = await createCommit(
                        IPFS_API_URL,
                        publishableDiff,
                        myDid,
                        settings.pinning.pinLocal,
                    );

                    // 6. Pin the commit
                    if (settings.pinning.pinLocal) {
                        await pinCid(IPFS_API_URL, commitCid);
                    }

                    // 7. Publish our new head under our OWN per-agent IPNS name
                    //    and announce it to peers (async — don't block on IPNS
                    //    publish latency).
                    republishHead(commitCid).catch(err => {
                        console.log(`[ipfs-link-language] head publish failed: ${err}`);
                    });

                    console.log(`[ipfs-link-language] committed: ${commitCid}`);
                } catch (err) {
                    console.log(`[ipfs-link-language] commit to IPFS failed: ${err}`);
                }
            }

            // 8. Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            // Discover every known peer's head (per-agent IPNS names), plus our
            // own name as a bootstrap, then converge the frontier via the
            // multi-parent DAG walk + OR-Set fold. On genuine divergence a
            // deterministic merge commit is created and republished.
            const peerNames = listPeerIpnsNames();
            const names = IPNS_NAME !== "<to-be-filled>" ? [IPNS_NAME, ...peerNames] : peerNames;

            if (names.length === 0) {
                return { additions: [], removals: [] };
            }

            return await syncFromPeers(IPFS_API_URL, names, {
                mergeAuthor: myDid,
                publishHead: (cid) => republishHead(cid),
                pin: settings.pinning.pinLocal,
            });
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            // Content hash of the current head frontier: a single head CID, or
            // a deterministic digest of the sorted head CIDs (a version-vector
            // digest). NEVER a cursor/timestamp.
            return currentRevisionHash();
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },

    // -----------------------------------------------------------------------
    // telepresence
    // -----------------------------------------------------------------------
    telepresence: {
        async setOnlineStatus(status: unknown): Promise<void> {
            if (NEIGHBOURHOOD_URL === "<to-be-filled>") {
                console.log("[ipfs-link-language] telepresence: no neighbourhood URL configured");
                return;
            }
            await publishPresence(IPFS_API_URL, NEIGHBOURHOOD_URL, myDid, status);
        },

        async getOnlineAgents(): Promise<unknown[]> {
            if (NEIGHBOURHOOD_URL === "<to-be-filled>") {
                return [];
            }
            const records = await queryOnlineAgents(IPFS_API_URL, NEIGHBOURHOOD_URL);
            return records;
        },

        async sendSignal(remoteDid: string, payload: unknown): Promise<object> {
            if (NEIGHBOURHOOD_URL === "<to-be-filled>") {
                return { status: "error", message: "no neighbourhood URL configured" };
            }
            return await pubsubSendSignal(
                IPFS_API_URL, NEIGHBOURHOOD_URL, myDid, remoteDid, payload,
            );
        },

        async sendBroadcast(payload: unknown): Promise<object> {
            if (NEIGHBOURHOOD_URL === "<to-be-filled>") {
                return { status: "error", message: "no neighbourhood URL configured" };
            }
            return await pubsubSendBroadcast(
                IPFS_API_URL, NEIGHBOURHOOD_URL, myDid, payload,
            );
        },

        async registerSignalCallback(callback: any): Promise<void> {
            // Wrap the caller's callback so head announcements are intercepted
            // (peer IPNS name recorded + head CID seeded into the frontier)
            // before being passed through.
            pubsubRegisterSignalCallback((msg: PubSubMessage) => {
                if (isHeadAnnounceMessage(msg)) {
                    ingestHeadAnnounce(msg);
                }
                callback(msg);
            });
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
    telepresenceSetOnlineStatus,
    telepresenceGetOnlineAgents,
    telepresenceSendSignal,
    telepresenceSendBroadcast,
    telepresenceRegisterSignalCallback,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}
