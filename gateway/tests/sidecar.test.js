/**
 * Sidecar unit tests — driven against a MOCK Kubo node (an in-process HTTP
 * server that answers the handful of /api/v0 endpoints the sidecar forwards
 * to and simulates gossipsub delivery across two "nodes"). No real Kubo /
 * Docker needed; these lock the routing + buffering contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SidecarState } from "../src/state.js";
import { createServer } from "../src/server.js";
import { encodeTopic, decodeMultibase } from "../src/kubo.js";

// ---------------------------------------------------------------------------
// Mock Kubo: a set of nodes that share pubsub delivery (gossipsub emulation)
// so a message published on one node is delivered to every node subscribed to
// that topic — exactly the cross-node behaviour we rely on (and that bitswap
// lacks). Each node also stores dag blocks locally.
// ---------------------------------------------------------------------------

function makeMockKuboCluster(nodeCount) {
  // Shared topic → list of { nodeId, push(record) } subscriber sinks.
  const topicSubs = new Map();
  const nodes = [];

  for (let n = 0; n < nodeCount; n++) {
    const blocks = new Map(); // cid → dag-json string
    let cidSeq = 0;
    const nodeId = `node-${n}`;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const bodyBuf = Buffer.concat(chunks);
        const path = url.pathname.replace("/api/v0", "");
        const arg = url.searchParams.get("arg");

        const sendJson = (obj) => {
          const s = JSON.stringify(obj);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(s);
        };

        if (path === "/id") {
          return sendJson({ ID: nodeId, Addresses: [] });
        }
        if (path === "/dag/put") {
          // Extract the JSON file part and assign a deterministic fake CID.
          const raw = bodyBuf.toString("utf-8");
          const start = raw.indexOf("\r\n\r\n");
          let payload = raw.slice(start + 4);
          const lb = payload.lastIndexOf("\r\n--");
          if (lb >= 0) payload = payload.slice(0, lb);
          const cid = `bafyMock${nodeId}-${cidSeq++}`;
          blocks.set(cid, payload);
          return sendJson({ Cid: { "/": cid } });
        }
        if (path === "/dag/get") {
          const block = blocks.get(arg);
          if (!block) {
            res.writeHead(500);
            return res.end("no block");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(block);
        }
        if (path === "/pin/add") {
          return sendJson({ Pins: [arg] });
        }
        if (path === "/pubsub/pub") {
          // arg is the multibase topic; body is multipart file payload.
          const raw = bodyBuf.toString("utf-8");
          const start = raw.indexOf("\r\n\r\n");
          let payload = raw.slice(start + 4);
          const lb = payload.lastIndexOf("\r\n--");
          if (lb >= 0) payload = payload.slice(0, lb);
          const sinks = topicSubs.get(arg) || [];
          const dataField = "u" + Buffer.from(payload, "utf-8").toString("base64url");
          for (const sink of sinks) {
            sink.push({ from: nodeId, data: dataField });
          }
          res.writeHead(200);
          return res.end("");
        }
        if (path === "/pubsub/sub") {
          // Streaming: register this connection as a subscriber to arg's topic.
          res.writeHead(200, { "Content-Type": "application/json" });
          const sink = {
            nodeId,
            push: (record) => {
              res.write(JSON.stringify(record) + "\n");
            },
          };
          const list = topicSubs.get(arg) || [];
          list.push(sink);
          topicSubs.set(arg, list);
          // Detach on the RESPONSE stream closing (client disconnect), NOT the
          // request: a bodyless POST's request stream ends/closes the instant
          // its (empty) body is consumed, while the long-lived receive channel
          // is the response — which stays open until the subscriber leaves.
          res.on("close", () => {
            const cur = topicSubs.get(arg) || [];
            topicSubs.set(arg, cur.filter((s) => s !== sink));
          });
          return; // keep open
        }
        res.writeHead(404);
        res.end("unknown");
      });
    });
    nodes.push(server);
  }

  return {
    nodes,
    async listen() {
      const urls = [];
      for (const server of nodes) {
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();
        urls.push(`http://127.0.0.1:${port}`);
      }
      return urls;
    },
    closeAll() {
      for (const s of nodes) s.close();
    },
  };
}

async function startSidecar(state) {
  const server = createServer(state);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

function req(base, method, path, { did, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (did) headers["X-Ad4m-Did"] = did;
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("encodeTopic / decodeMultibase round-trip", () => {
  const topic = "ad4m/neighbourhood://abc/diffs";
  const enc = encodeTopic(topic);
  assert.equal(enc[0], "u");
  assert.equal(decodeMultibase(enc).toString("utf-8"), topic);
});

test("per-DID routing: two DIDs map to two distinct nodes (round-robin)", () => {
  const state = new SidecarState(["http://a", "http://b"]);
  const nodeA = state.nodeUrlForDid("did:key:alice");
  const nodeB = state.nodeUrlForDid("did:key:bob");
  assert.notEqual(nodeA, nodeB, "distinct DIDs must land on distinct nodes");
  // Stable across repeated lookups.
  assert.equal(state.nodeUrlForDid("did:key:alice"), nodeA);
  assert.equal(state.nodeUrlForDid("did:key:bob"), nodeB);
});

test("explicit AGENT_NODES mapping wins over round-robin", () => {
  const state = new SidecarState(["http://a", "http://b"], {
    "did:key:pinned": "http://b",
  });
  assert.equal(state.nodeUrlForDid("did:key:pinned"), "http://b");
});

test("dag/put then dag/get routes to the SAME node for one DID", async () => {
  const cluster = makeMockKuboCluster(2);
  const urls = await cluster.listen();
  const state = new SidecarState(urls);
  const { server, base } = await startSidecar(state);
  try {
    const did = "did:key:writer";
    const put = await req(base, "POST", "/kubo/dag/put", {
      did,
      body: { node: { type: "ad4m:PerspectiveCommit", additions: [], removals: [], previous: [] } },
    });
    assert.equal(put.status, 200);
    const cid = put.json.Cid["/"];
    assert.ok(cid, "got a CID");

    const get = await req(base, "POST", "/kubo/dag/get", { did, body: { cid } });
    assert.equal(get.status, 200);
    assert.equal(get.json.type, "ad4m:PerspectiveCommit");
  } finally {
    server.close();
    state.closeAll();
    cluster.closeAll();
  }
});

test("inline diff crosses nodes over pubsub: A publishes, B receives via /messages", async () => {
  const cluster = makeMockKuboCluster(2);
  const urls = await cluster.listen();
  // Pin each DID to a specific node so this is genuinely cross-node.
  const state = new SidecarState(urls, {
    "did:key:A": urls[0],
    "did:key:B": urls[1],
  });
  const { server, base } = await startSidecar(state);
  try {
    const topic = "ad4m/neighbourhood://c1/diffs";

    // B subscribes first (its first /messages poll starts the sub).
    const first = await req(base, "GET", `/messages?topic=${encodeURIComponent(topic)}&since=0`, {
      did: "did:key:B",
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.messages, []);
    assert.equal(first.json.nextSeq, 0);

    // Give the sub a tick to attach to the mock cluster.
    await new Promise((r) => setTimeout(r, 50));

    // A publishes an inline commit.
    const payload = JSON.stringify({ type: "inline-commit", did: "did:key:A", cid: "bafyX", commit: {} });
    const pub = await req(base, "POST", "/publish", { did: "did:key:A", body: { topic, data: payload } });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.ok, true);

    // Poll B until the message shows up.
    let got = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const poll = await req(base, "GET", `/messages?topic=${encodeURIComponent(topic)}&since=0`, {
        did: "did:key:B",
      });
      if (poll.json.messages.length > 0) {
        got = poll.json;
        break;
      }
    }
    assert.ok(got, "B received the inline commit cross-node");
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].data, payload);
    assert.equal(got.nextSeq, 1);
  } finally {
    server.close();
    state.closeAll();
    cluster.closeAll();
  }
});

test("/messages since cursor returns only newer messages", async () => {
  const cluster = makeMockKuboCluster(1);
  const urls = await cluster.listen();
  const state = new SidecarState(urls);
  const { server, base } = await startSidecar(state);
  try {
    const topic = "t/cursor";
    const did = "did:key:only";
    // Start sub.
    await req(base, "GET", `/messages?topic=${encodeURIComponent(topic)}&since=0`, { did });
    await new Promise((r) => setTimeout(r, 50));
    // Publish two.
    await req(base, "POST", "/publish", { did, body: { topic, data: "m1" } });
    await req(base, "POST", "/publish", { did, body: { topic, data: "m2" } });

    let all = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const poll = await req(base, "GET", `/messages?topic=${encodeURIComponent(topic)}&since=0`, { did });
      if (poll.json.messages.length >= 2) {
        all = poll.json;
        break;
      }
    }
    assert.ok(all, "received both messages");
    assert.equal(all.nextSeq, 2);

    // since=1 returns only the second.
    const tail = await req(base, "GET", `/messages?topic=${encodeURIComponent(topic)}&since=1`, { did });
    assert.equal(tail.json.messages.length, 1);
    assert.equal(tail.json.messages[0].data, "m2");
  } finally {
    server.close();
    state.closeAll();
    cluster.closeAll();
  }
});

test("health reports node + subscription counts", async () => {
  const state = new SidecarState(["http://a", "http://b"]);
  const { server, base } = await startSidecar(state);
  try {
    const h = await req(base, "GET", "/health");
    assert.equal(h.status, 200);
    assert.equal(h.json.status, "ok");
    assert.equal(h.json.nodes, 2);
  } finally {
    server.close();
    state.closeAll();
  }
});
