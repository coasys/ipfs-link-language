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

import { getTransport } from "./transport.js";
import {
    dagPutUrl,
    dagGetUrl,
    namePublishUrl,
    nameResolveUrl,
    pinAddUrl,
    pinRmUrl,
    keyGenUrl,
    keyListUrl,
    parseDagPutResponse,
    parseNameResolveResponse,
    parseNamePublishResponse,
    parsePinAddResponse,
    parseKeyGenResponse,
    parseKeyListResponse,
} from "./ipfs-api.pure.js";
import { dagJsonEncode, dagJsonDecode } from "./ipld.pure.js";

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

    const response = await getTransport().fetch(
        url,
        "POST",
        { "Content-Type": "application/json" },
        body,
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
