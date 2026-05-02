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
import { shouldPublish, linkOriginKey, linkContentHash, isExcludedPredicate } from "./src/dual-language.js";
import type { LinkOrigin } from "./src/dual-language.js";
import * as store from "./src/store.js";
import { createCommit, getHeadCid } from "./src/perspective-dag.js";
import { syncFromIPNS, fullSync } from "./src/sync.js";
import { ipnsPublish } from "./src/ipfs-api.js";
import { pinCid } from "./src/pinning.js";
import {
    publishPresence,
    queryOnlineAgents,
    sendSignal as pubsubSendSignal,
    sendBroadcast as pubsubSendBroadcast,
    registerSignalCallback as pubsubRegisterSignalCallback,
    clearSignalCallback,
} from "./src/pubsub.js";

// Adapter imports (interfaces for singletons, Deno impls for init)
import { initTransport } from "./src/transport.js";
import { DenoTransport } from "./src/transport-deno.js";
import { initStorage, getStorage } from "./src/storage-interface.js";
import { DenoStorageAdapter } from "./src/storage-deno.js";
import { initSigning } from "./src/signing-interface.js";
import { DenoSigningAdapter } from "./src/signing-deno.js";
import { initRuntime } from "./src/runtime-interface.js";
import { DenoRuntime } from "./src/runtime-deno.js";

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

        console.log(`[ipfs-link-language] init: did=${myDid}`);
        console.log(`[ipfs-link-language] IPFS API: ${IPFS_API_URL}`);
        console.log(`[ipfs-link-language] IPNS name: ${IPNS_NAME}`);
        console.log(`[ipfs-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[ipfs-link-language] codec: ${settings.codec}`);

        // If we have an IPNS name and no local head, do a full initial sync
        if (IPNS_NAME !== "<to-be-filled>" && !getHeadCid()) {
            try {
                const diff = await syncFromIPNS(IPFS_API_URL, IPNS_NAME);
                if (diff.additions.length > 0 || diff.removals.length > 0) {
                    console.log(`[ipfs-link-language] initial sync: ${diff.additions.length} additions, ${diff.removals.length} removals`);
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

    interactions() {
        return [];
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

                    // 7. Update IPNS (async — don't block on publish latency)
                    if (IPNS_NAME !== "<to-be-filled>") {
                        ipnsPublish(
                            IPFS_API_URL,
                            commitCid,
                            settings.ipns.keyName,
                            settings.ipns.ttlSeconds,
                        ).catch(err => {
                            console.log(`[ipfs-link-language] IPNS publish failed: ${err}`);
                        });
                    }

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

            if (IPNS_NAME === "<to-be-filled>") {
                return { additions: [], removals: [] };
            }

            return await syncFromIPNS(IPFS_API_URL, IPNS_NAME);
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return store.getRevision() || "";
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
            pubsubRegisterSignalCallback(callback);
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
    interactions,
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
