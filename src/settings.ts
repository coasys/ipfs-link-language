/**
 * Settings for the IPFS/IPLD Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults per Spec §9.
 */

export interface IPNSSettings {
    /** IPNS key name in the local IPFS node */
    keyName: string;
    /** IPNS record TTL (seconds) */
    ttlSeconds: number;
    /** Polling interval for IPNS resolution (ms) */
    pollIntervalMs: number;
}

export interface PinningSettings {
    /** Pin locally */
    pinLocal: boolean;
    /** Pin to remote service */
    pinRemote: boolean;
    /** Remote pinning service API key */
    remoteApiKey: string;
}

export interface PubSubSettings {
    /** Enable PubSub for real-time notifications */
    enabled: boolean;
    /** PubSub topic prefix */
    topicPrefix: string;
}

export interface DAGSettings {
    /** Max links per leaf node in the HAMT */
    hamtBucketSize: number;
    /** Include diff chain for efficient sync */
    includeDiffChain: boolean;
}

export interface DualLanguageSettings {
    enabled: boolean;
    excludePredicates: string[];
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";
export type Codec = "dag-cbor" | "dag-json";

export interface IPFSSettings {
    /** Sync direction */
    syncMode: SyncMode;
    /** IPLD encoding — we use dag-json for WASM/pure-JS compatibility */
    codec: Codec;
    /** IPNS configuration */
    ipns: IPNSSettings;
    /** Pinning */
    pinning: PinningSettings;
    /** PubSub (experimental) */
    pubsub: PubSubSettings;
    /** DAG structure */
    dag: DAGSettings;
    /** Dual-language */
    dualLanguage: DualLanguageSettings;
}

/** Default settings — sensible defaults for bidirectional IPFS sync. */
export const DEFAULT_SETTINGS: IPFSSettings = {
    syncMode: "bidirectional",
    codec: "dag-json",
    ipns: {
        keyName: "ad4m-neighbourhood",
        ttlSeconds: 60,
        pollIntervalMs: 30000,
    },
    pinning: {
        pinLocal: true,
        pinRemote: false,
        remoteApiKey: "",
    },
    pubsub: {
        enabled: false,
        topicPrefix: "/ad4m/neighbourhood/",
    },
    dag: {
        hamtBucketSize: 256,
        includeDiffChain: true,
    },
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): IPFSSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw);
        return {
            syncMode: (["bidirectional", "publish-only", "subscribe-only"] as const)
                .includes(parsed?.syncMode) ? parsed.syncMode : DEFAULT_SETTINGS.syncMode,
            codec: (["dag-cbor", "dag-json"] as const)
                .includes(parsed?.codec) ? parsed.codec : DEFAULT_SETTINGS.codec,
            ipns: {
                keyName: typeof parsed?.ipns?.keyName === "string"
                    ? parsed.ipns.keyName : DEFAULT_SETTINGS.ipns.keyName,
                ttlSeconds: typeof parsed?.ipns?.ttlSeconds === "number" && parsed.ipns.ttlSeconds > 0
                    ? parsed.ipns.ttlSeconds : DEFAULT_SETTINGS.ipns.ttlSeconds,
                pollIntervalMs: typeof parsed?.ipns?.pollIntervalMs === "number" && parsed.ipns.pollIntervalMs > 0
                    ? parsed.ipns.pollIntervalMs : DEFAULT_SETTINGS.ipns.pollIntervalMs,
            },
            pinning: {
                pinLocal: typeof parsed?.pinning?.pinLocal === "boolean"
                    ? parsed.pinning.pinLocal : DEFAULT_SETTINGS.pinning.pinLocal,
                pinRemote: typeof parsed?.pinning?.pinRemote === "boolean"
                    ? parsed.pinning.pinRemote : DEFAULT_SETTINGS.pinning.pinRemote,
                remoteApiKey: typeof parsed?.pinning?.remoteApiKey === "string"
                    ? parsed.pinning.remoteApiKey : DEFAULT_SETTINGS.pinning.remoteApiKey,
            },
            pubsub: {
                enabled: typeof parsed?.pubsub?.enabled === "boolean"
                    ? parsed.pubsub.enabled : DEFAULT_SETTINGS.pubsub.enabled,
                topicPrefix: typeof parsed?.pubsub?.topicPrefix === "string"
                    ? parsed.pubsub.topicPrefix : DEFAULT_SETTINGS.pubsub.topicPrefix,
            },
            dag: {
                hamtBucketSize: typeof parsed?.dag?.hamtBucketSize === "number" && parsed.dag.hamtBucketSize > 0
                    ? parsed.dag.hamtBucketSize : DEFAULT_SETTINGS.dag.hamtBucketSize,
                includeDiffChain: typeof parsed?.dag?.includeDiffChain === "boolean"
                    ? parsed.dag.includeDiffChain : DEFAULT_SETTINGS.dag.includeDiffChain,
            },
            dualLanguage: {
                enabled: typeof parsed?.dualLanguage?.enabled === "boolean"
                    ? parsed.dualLanguage.enabled : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates: Array.isArray(parsed?.dualLanguage?.excludePredicates)
                    ? parsed.dualLanguage.excludePredicates : DEFAULT_SETTINGS.dualLanguage.excludePredicates,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
