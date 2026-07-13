/**
 * Kubo HTTP API client for the pubsub-bridge sidecar.
 *
 * A thin wrapper over one Kubo node's `/api/v0` HTTP surface, run in Node.js
 * (NOT the Deno sandbox), so it can:
 *   - hold a long-lived streaming `pubsub/sub` connection (the sandbox's
 *     httpFetch buffers + UTF-8-decodes the whole body, so it can publish to a
 *     topic but can never keep a receive stream open); and
 *   - forward the handful of unary Kubo ops the language needs (dag/put,
 *     dag/get, name/publish, name/resolve, key/gen, key/list, pin/add,
 *     pubsub/pub) verbatim.
 *
 * Topic encoding: Kubo 0.41+ takes pubsub topics as multibase base64url
 * (no-pad) with a leading `u`. `encodeTopic` produces exactly that so the
 * sidecar and the in-sandbox language agree on the wire topic.
 */

import http from "http";
import { Buffer } from "buffer";

/**
 * Multibase base64url (no-pad) encoding of a topic string, `u`-prefixed.
 * Mirrors the language's `encodeTopicMultibase` so both sides address the
 * same Kubo topic.
 * @param {string} topic
 * @returns {string}
 */
export function encodeTopic(topic) {
  const b64 = Buffer.from(topic, "utf-8").toString("base64");
  return "u" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a Kubo multibase-encoded field (the `data`/`from` fields of a pubsub
 * message are `u`-prefixed base64url) to a Buffer.
 * @param {string} value
 * @returns {Buffer}
 */
export function decodeMultibase(value) {
  if (typeof value !== "string" || value.length === 0) return Buffer.alloc(0);
  if (value[0] === "u") {
    const b64 = value.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64");
  }
  // Fallback: assume standard base64 (older Kubo HTTP behaviour).
  return Buffer.from(value, "base64");
}

/**
 * One Kubo node, addressed by its HTTP API base URL (e.g.
 * "http://127.0.0.1:5001").
 */
export class KuboClient {
  /**
   * @param {string} apiUrl  Kubo HTTP API base (no trailing slash needed).
   */
  constructor(apiUrl) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  /**
   * POST to a Kubo `/api/v0` endpoint. Kubo's API is POST-only.
   * @param {string} path   e.g. "/dag/get?arg=..."
   * @param {{ contentType?: string, body?: string|Buffer, timeoutMs?: number }} [opts]
   * @returns {Promise<{ status: number, body: string }>}
   */
  async post(path, opts = {}) {
    const url = `${this.apiUrl}/api/v0${path}`;
    const headers = {};
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    // Optional hard timeout. Used by dag/get: a block the local node holds
    // returns in milliseconds, but a block that lives ONLY on a peer triggers a
    // cross-node bitswap fetch that, on Kubo 0.42.0, never completes and hangs
    // for the daemon's full internal timeout (~30-50s). A short abort turns that
    // doomed fetch into a fast, catchable error so the caller's DAG walk can
    // skip the unreachable block and converge on what IS local + inlined.
    let signal;
    let timer = null;
    if (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) {
      const ac = new AbortController();
      signal = ac.signal;
      timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: opts.body,
        signal,
      });
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      if (err && err.name === "AbortError") {
        return { status: 504, body: `kubo ${path} timed out after ${opts.timeoutMs}ms` };
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Return this node's peer id (used to peer nodes together).
   * @returns {Promise<{ id: string, addresses: string[] }>}
   */
  async id() {
    const { status, body } = await this.post("/id");
    if (status < 200 || status >= 300) {
      throw new Error(`id failed: HTTP ${status} — ${body}`);
    }
    const parsed = JSON.parse(body);
    return { id: parsed.ID, addresses: parsed.Addresses || [] };
  }

  /**
   * Connect this node's swarm to a peer multiaddr (…/p2p/<peerId>).
   * @param {string} multiaddr
   * @returns {Promise<{ status: number, body: string }>}
   */
  async swarmConnect(multiaddr) {
    return this.post(`/swarm/connect?arg=${encodeURIComponent(multiaddr)}`);
  }

  /**
   * Publish a message payload to a pubsub topic.
   * @param {string} topic  raw (un-encoded) topic string
   * @param {string|Buffer} data
   * @returns {Promise<void>}
   */
  async pubsubPublish(topic, data) {
    const encoded = encodeTopic(topic);
    const boundary = "ipfs-sidecar-boundary";
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf-8");
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="data"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      "utf-8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
    const body = Buffer.concat([head, payload, tail]);
    const { status, body: resBody } = await this.post(
      `/pubsub/pub?arg=${encoded}`,
      { contentType: `multipart/form-data; boundary=${boundary}`, body },
    );
    if (status < 200 || status >= 300) {
      throw new Error(`pubsub/pub failed: HTTP ${status} — ${resBody}`);
    }
  }

  /**
   * Open a long-lived streaming subscription to a pubsub topic. Kubo streams
   * newline-delimited JSON records; `onMessage` is invoked once per record
   * with the parsed object (fields include base64url `data`, `from`, `seqno`).
   *
   * Returns an object with `close()` to tear the stream down. The request uses
   * the raw `http` module (not `fetch`) so we get an incremental readable body
   * that never buffers to completion.
   *
   * @param {string} topic  raw (un-encoded) topic string
   * @param {(msg: any) => void} onMessage
   * @param {(err: Error) => void} [onError]
   * @returns {{ close: () => void }}
   */
  subscribe(topic, onMessage, onError) {
    const encoded = encodeTopic(topic);
    const url = new URL(`${this.apiUrl}/api/v0/pubsub/sub?arg=${encoded}`);
    let closed = false;
    let req = null;

    const start = () => {
      if (closed) return;
      req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "POST",
        },
        (res) => {
          res.setEncoding("utf-8");
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                onMessage(JSON.parse(line));
              } catch {
                /* skip malformed record */
              }
            }
          });
          res.on("end", () => {
            // Kubo closed the stream (daemon restart, topic churn). Reconnect
            // unless we were explicitly closed.
            if (!closed) setTimeout(start, 500);
          });
          res.on("error", (err) => {
            if (!closed && onError) onError(err);
            if (!closed) setTimeout(start, 500);
          });
        },
      );
      req.on("error", (err) => {
        if (!closed && onError) onError(err);
        if (!closed) setTimeout(start, 500);
      });
      // pubsub/sub takes no body; end the request to open the stream.
      req.end();
    };

    start();

    return {
      close() {
        closed = true;
        try {
          if (req) req.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
