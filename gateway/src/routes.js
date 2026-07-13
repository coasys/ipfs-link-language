/**
 * REST handlers for the IPFS pubsub-bridge sidecar.
 *
 * Contract consumed by the ipfs AD4M Link Language (over the sandbox's
 * httpFetch). Every request carries the agent's DID in the `X-Ad4m-Did`
 * header; the sidecar routes it to that agent's Kubo node (see state.js).
 *
 * | Method | Path                          | Body / Query                    | Response                                   |
 * |--------|-------------------------------|---------------------------------|--------------------------------------------|
 * | GET    | /health                       | —                               | { status, nodes, subscriptions }           |
 * | GET    | /messages?topic=<t>&since=<n> | topic raw; since = last seq (0) | { messages:[{seq,from,data}], nextSeq }    |
 * | POST   | /publish                      | { topic, data }                 | { ok: true }                               |
 * | POST   | /kubo/dag/put                 | { node } (dag-json)             | { Cid: { "/": cid } }  (Kubo passthrough)  |
 * | POST   | /kubo/dag/get                 | { cid }                         | <dag-json node>        (Kubo passthrough)  |
 * | POST   | /kubo/pin/add                 | { cid, recursive? }             | { Pins: [...] }        (Kubo passthrough)  |
 * | POST   | /kubo/name/publish            | { cid, key?, ttlSeconds? }      | { Name, Value }        (Kubo passthrough)  |
 * | POST   | /kubo/name/resolve            | { name }                        | { Path }               (Kubo passthrough)  |
 * | POST   | /kubo/key/gen                 | { name, type? }                 | { Name, Id }           (Kubo passthrough)  |
 * | POST   | /kubo/key/list                | —                               | { Keys: [...] }        (Kubo passthrough)  |
 *
 * The /kubo/* endpoints are thin forwarders: the language keeps building
 * multibase topics, dag-json bodies, and CIDs exactly as it would against a
 * bare Kubo node, and the sidecar only redirects the call to the DID's node.
 * The convergence path (inline diff commits over pubsub) rides /publish +
 * /messages so it sidesteps bitswap, which does not transfer blocks cross-node
 * on Kubo 0.42.0.
 *
 * Payload-size note: gossipsub caps a single message near ~1 MiB. A commit body
 * carrying a very large diff could exceed that; the language keeps per-commit
 * diffs small (AD4M commits are per-link-batch), so no chunking is implemented
 * here. Publishing returns the Kubo error verbatim if a payload is rejected.
 */

const MULTIPART_BOUNDARY = "ipfs-sidecar-dagput";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function err(res, status, message) {
  json(res, status, { error: message });
}

/** Read the agent DID from the request headers (case-insensitive). */
function didOf(req) {
  const h = req.headers["x-ad4m-did"];
  return typeof h === "string" && h.length > 0 ? h : undefined;
}

/**
 * Forward a raw string body to a Kubo endpoint and relay its response
 * verbatim (status + body). Used by every /kubo/* passthrough.
 */
async function relay(res, client, path, opts) {
  const { status, body } = await client.post(path, opts);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function health(state) {
  return async (_req, res) => {
    json(res, 200, {
      status: "ok",
      nodes: state.nodeUrls.length,
      subscriptions: state.subscriptionCount(),
    });
  };
}

// ---------------------------------------------------------------------------
// PubSub receive (pollable) + publish
// ---------------------------------------------------------------------------

export function getMessages(state) {
  return async (req, res, _params, _body, query) => {
    const topic = query.get("topic");
    if (!topic) return err(res, 400, "topic query param required");
    const since = parseInt(query.get("since") || "0", 10);
    const did = didOf(req);
    const { messages, nextSeq } = state.messagesSince(did, topic, Number.isFinite(since) ? since : 0);
    json(res, 200, { messages, nextSeq });
  };
}

export function publish(state) {
  return async (req, res, _params, body) => {
    if (!body || typeof body.topic !== "string" || body.topic.length === 0) {
      return err(res, 400, "body.topic (string) required");
    }
    if (typeof body.data !== "string") {
      return err(res, 400, "body.data (string) required");
    }
    const did = didOf(req);
    const client = state.clientForDid(did);
    // Opening a subscription on the same node makes this agent a topic peer, so
    // gossipsub actually forwards its own and others' messages. Idempotent.
    state.ensureSubscription(did, body.topic);
    try {
      await client.pubsubPublish(body.topic, body.data);
      json(res, 200, { ok: true });
    } catch (e) {
      err(res, 502, `pubsub/pub failed: ${e.message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Kubo passthrough (routed to the DID's node)
// ---------------------------------------------------------------------------

export function dagPut(state) {
  return async (req, res, _params, body) => {
    if (!body || body.node === undefined) return err(res, 400, "body.node required");
    const client = state.clientForDid(didOf(req));
    const pin = body.pin === false ? false : true;
    const dagJson = JSON.stringify(body.node);
    const head =
      `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="data"\r\n` +
      `Content-Type: application/json\r\n\r\n`;
    const multipart = `${head}${dagJson}\r\n--${MULTIPART_BOUNDARY}--\r\n`;
    await relay(
      res,
      client,
      `/dag/put?store-codec=dag-json&input-codec=dag-json&pin=${pin}`,
      { contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`, body: multipart },
    );
  };
}

export function dagGet(state) {
  return async (req, res, _params, body) => {
    const cid = body && body.cid;
    if (typeof cid !== "string" || !cid) return err(res, 400, "body.cid required");
    const client = state.clientForDid(didOf(req));
    // Bounded: a locally-held block returns in ms; a peer-only block would
    // otherwise hang on the (never-completing) cross-node bitswap fetch. The
    // convergence path never NEEDS a cross-node dag/get — peers ship every
    // commit body inline over pubsub — so a short timeout only ever trims a
    // doomed fetch, letting the caller's walk skip it and converge.
    await relay(res, client, `/dag/get?arg=${encodeURIComponent(cid)}&output-codec=dag-json`, {
      timeoutMs: 3000,
    });
  };
}

export function pinAdd(state) {
  return async (req, res, _params, body) => {
    const cid = body && body.cid;
    if (typeof cid !== "string" || !cid) return err(res, 400, "body.cid required");
    const recursive = body.recursive === false ? false : true;
    const client = state.clientForDid(didOf(req));
    await relay(res, client, `/pin/add?arg=${encodeURIComponent(cid)}&recursive=${recursive}`, {});
  };
}

export function namePublish(state) {
  return async (req, res, _params, body) => {
    const cid = body && body.cid;
    if (typeof cid !== "string" || !cid) return err(res, 400, "body.cid required");
    let path = `/name/publish?arg=${encodeURIComponent(cid)}`;
    if (body.key) path += `&key=${encodeURIComponent(body.key)}`;
    if (typeof body.ttlSeconds === "number") path += `&ttl=${body.ttlSeconds}s`;
    const client = state.clientForDid(didOf(req));
    await relay(res, client, path, {});
  };
}

export function nameResolve(state) {
  return async (req, res, _params, body) => {
    const name = body && body.name;
    if (typeof name !== "string" || !name) return err(res, 400, "body.name required");
    const client = state.clientForDid(didOf(req));
    await relay(res, client, `/name/resolve?arg=${encodeURIComponent(name)}`, {});
  };
}

export function keyGen(state) {
  return async (req, res, _params, body) => {
    const name = body && body.name;
    if (typeof name !== "string" || !name) return err(res, 400, "body.name required");
    const type = (body && body.type) || "ed25519";
    const client = state.clientForDid(didOf(req));
    await relay(res, client, `/key/gen?arg=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {});
  };
}

export function keyList(state) {
  return async (req, res) => {
    const client = state.clientForDid(didOf(req));
    await relay(res, client, `/key/list`, {});
  };
}
