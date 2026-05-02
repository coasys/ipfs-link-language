/**
 * Pure IPFS HTTP API request builders — zero runtime deps.
 *
 * Builds URL strings and request bodies for the IPFS HTTP API.
 * The actual HTTP calls are made by the transport layer.
 */

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Build the URL for dag/put.
 */
export function dagPutUrl(apiUrl: string, pin: boolean = true, codec: string = "dag-json"): string {
    return `${apiUrl}/api/v0/dag/put?store-codec=${codec}&input-codec=${codec}&pin=${pin}`;
}

/**
 * Build the URL for dag/get.
 */
export function dagGetUrl(apiUrl: string, cid: string, codec: string = "dag-json"): string {
    return `${apiUrl}/api/v0/dag/get?arg=${encodeURIComponent(cid)}&output-codec=${codec}`;
}

/**
 * Build the URL for name/publish (IPNS).
 */
export function namePublishUrl(
    apiUrl: string,
    cid: string,
    keyName?: string,
    ttlSeconds?: number,
): string {
    let url = `${apiUrl}/api/v0/name/publish?arg=${encodeURIComponent(cid)}`;
    if (keyName) url += `&key=${encodeURIComponent(keyName)}`;
    if (ttlSeconds !== undefined) url += `&ttl=${ttlSeconds}s`;
    return url;
}

/**
 * Build the URL for name/resolve (IPNS).
 */
export function nameResolveUrl(apiUrl: string, ipnsName: string): string {
    return `${apiUrl}/api/v0/name/resolve?arg=${encodeURIComponent(ipnsName)}`;
}

/**
 * Build the URL for pin/add.
 */
export function pinAddUrl(apiUrl: string, cid: string, recursive: boolean = true): string {
    return `${apiUrl}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=${recursive}`;
}

/**
 * Build the URL for pin/rm.
 */
export function pinRmUrl(apiUrl: string, cid: string, recursive: boolean = true): string {
    return `${apiUrl}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}&recursive=${recursive}`;
}

/**
 * Build the URL for pin/ls.
 */
export function pinLsUrl(apiUrl: string): string {
    return `${apiUrl}/api/v0/pin/ls`;
}

/**
 * Build the URL for key/gen.
 */
export function keyGenUrl(apiUrl: string, keyName: string, type: string = "ed25519"): string {
    return `${apiUrl}/api/v0/key/gen?arg=${encodeURIComponent(keyName)}&type=${type}`;
}

/**
 * Build the URL for key/list.
 */
export function keyListUrl(apiUrl: string): string {
    return `${apiUrl}/api/v0/key/list`;
}

/**
 * Build the URL for dag/export (CAR file).
 */
export function dagExportUrl(apiUrl: string, cid: string): string {
    return `${apiUrl}/api/v0/dag/export?arg=${encodeURIComponent(cid)}`;
}

/**
 * Build the URL for dag/import (CAR file).
 */
export function dagImportUrl(apiUrl: string): string {
    return `${apiUrl}/api/v0/dag/import`;
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse a dag/put response to extract the CID.
 */
export function parseDagPutResponse(body: string): string {
    const result = JSON.parse(body);
    const cid = result.Cid?.["/"] || result.Cid || result.Hash || result.Key;
    if (!cid) {
        throw new Error(`dag/put returned no CID: ${body}`);
    }
    return typeof cid === "string" ? cid : String(cid);
}

/**
 * Parse a name/resolve response to extract the resolved path.
 */
export function parseNameResolveResponse(body: string): string {
    const result = JSON.parse(body);
    const path: string = result.Path || "";
    // Path is typically "/ipfs/bafy..."
    if (path.startsWith("/ipfs/")) {
        return path.substring(6);
    }
    return path;
}

/**
 * Parse a name/publish response.
 */
export function parseNamePublishResponse(body: string): { name: string; value: string } {
    const result = JSON.parse(body);
    return {
        name: result.Name || "",
        value: result.Value || "",
    };
}

/**
 * Parse a pin/add response.
 */
export function parsePinAddResponse(body: string): string[] {
    const result = JSON.parse(body);
    const pins = result.Pins || [result.Hash].filter(Boolean);
    return pins;
}

/**
 * Parse a key/gen response.
 */
export function parseKeyGenResponse(body: string): { name: string; id: string } {
    const result = JSON.parse(body);
    return {
        name: result.Name || "",
        id: result.Id || "",
    };
}

/**
 * Parse a key/list response.
 */
export function parseKeyListResponse(body: string): Array<{ name: string; id: string }> {
    const result = JSON.parse(body);
    const keys = result.Keys || [];
    return keys.map((k: { Name: string; Id: string }) => ({
        name: k.Name || "",
        id: k.Id || "",
    }));
}
