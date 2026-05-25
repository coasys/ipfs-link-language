/**
 * IPFS HTTP API client — uses getTransport() for all HTTP calls.
 *
 * Provides high-level methods for the IPFS Kubo HTTP API:
 * - dag/put, dag/get
 * - name/publish, name/resolve
 * - pin/add, pin/rm, pin/ls
 * - key/gen, key/list
 *
 * No ad4m:host imports — uses injected transport adapter.
 */

import { getTransport } from "./adapters.js";
import { dagJsonEncode, dagJsonDecode } from "./ipld.js";
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


// ---------------------------------------------------------------------------
// DAG operations
// ---------------------------------------------------------------------------

/**
 * Store a DAG-JSON node on IPFS.
 * Returns the CID of the stored node.
 */
export async function ipfsDagPut(
    apiUrl: string,
    data: unknown,
    pin: boolean = true,
): Promise<string> {
    const url = dagPutUrl(apiUrl, pin);
    const body = dagJsonEncode(data);

    // Kubo's dag/put API requires multipart form data.
    // Construct a minimal multipart body since httpFetch only supports string bodies.
    const boundary = "ad4m-ipfs-boundary";
    const multipartBody = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="data"\r\n`,
        `Content-Type: application/json\r\n`,
        `\r\n`,
        body,
        `\r\n`,
        `--${boundary}--\r\n`,
    ].join("");

    const response = await getTransport().fetch(
        url,
        "POST",
        { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        multipartBody,
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`dag/put failed: HTTP ${response.status} — ${response.body}`);
    }

    return parseDagPutResponse(response.body);
}

/**
 * Retrieve a DAG-JSON node from IPFS by CID.
 */
export async function ipfsDagGet<T = unknown>(
    apiUrl: string,
    cid: string,
): Promise<T> {
    const url = dagGetUrl(apiUrl, cid);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`dag/get failed: HTTP ${response.status} — ${response.body}`);
    }

    return dagJsonDecode<T>(response.body);
}

// ---------------------------------------------------------------------------
// IPNS operations
// ---------------------------------------------------------------------------

/**
 * Publish an IPNS record pointing to a CID.
 */
export async function ipnsPublish(
    apiUrl: string,
    cid: string,
    keyName?: string,
    ttlSeconds?: number,
): Promise<{ name: string; value: string }> {
    const url = namePublishUrl(apiUrl, cid, keyName, ttlSeconds);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`name/publish failed: HTTP ${response.status} — ${response.body}`);
    }

    return parseNamePublishResponse(response.body);
}

/**
 * Resolve an IPNS name to a CID.
 */
export async function ipnsResolve(
    apiUrl: string,
    ipnsName: string,
): Promise<string> {
    const url = nameResolveUrl(apiUrl, ipnsName);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`name/resolve failed: HTTP ${response.status} — ${response.body}`);
    }

    return parseNameResolveResponse(response.body);
}

// ---------------------------------------------------------------------------
// Pin operations
// ---------------------------------------------------------------------------

/**
 * Pin a CID on the IPFS node.
 */
export async function ipfsPinAdd(
    apiUrl: string,
    cid: string,
    recursive: boolean = true,
): Promise<string[]> {
    const url = pinAddUrl(apiUrl, cid, recursive);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`pin/add failed: HTTP ${response.status} — ${response.body}`);
    }

    return parsePinAddResponse(response.body);
}

/**
 * Unpin a CID on the IPFS node.
 */
export async function ipfsPinRm(
    apiUrl: string,
    cid: string,
    recursive: boolean = true,
): Promise<void> {
    const url = pinRmUrl(apiUrl, cid, recursive);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`pin/rm failed: HTTP ${response.status} — ${response.body}`);
    }
}

// ---------------------------------------------------------------------------
// Key operations
// ---------------------------------------------------------------------------

/**
 * Generate a new IPNS key.
 */
export async function ipfsKeyGen(
    apiUrl: string,
    keyName: string,
    type: string = "ed25519",
): Promise<{ name: string; id: string }> {
    const url = keyGenUrl(apiUrl, keyName, type);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`key/gen failed: HTTP ${response.status} — ${response.body}`);
    }

    return parseKeyGenResponse(response.body);
}

/**
 * List IPNS keys on the node.
 */
export async function ipfsKeyList(
    apiUrl: string,
): Promise<Array<{ name: string; id: string }>> {
    const url = keyListUrl(apiUrl);

    const response = await getTransport().fetch(url, "POST", {}, "");

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`key/list failed: HTTP ${response.status} — ${response.body}`);
    }

    return parseKeyListResponse(response.body);
}
