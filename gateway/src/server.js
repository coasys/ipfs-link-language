/**
 * IPFS pubsub-bridge sidecar — HTTP server.
 *
 * A Node.js sidecar the Deno-sandboxed IPFS AD4M link language reaches over
 * HTTP. The sandbox's httpFetch buffers and UTF-8-decodes the whole response
 * body, so a language running inside it can PUBLISH to an IPFS pubsub topic but
 * can never hold a long-lived `pubsub/sub` receive stream. This sidecar owns
 * that streaming: it keeps one subscription per (node, topic), buffers messages
 * with a monotonic per-topic sequence, and serves them back via a pollable
 * `GET /messages`. It also forwards the unary Kubo ops the language needs.
 *
 * Cross-node transport rides pubsub, NOT bitswap: on Kubo 0.42.0 two
 * directly-peered nodes never negotiate `/ipfs/bitswap`, so `dag/get` of a
 * peer's CID times out. The language therefore publishes each new commit body
 * INLINE over pubsub and folds peers' inline commits through its existing OR-Set
 * DAG walk; blocks are still written locally for the local revision.
 *
 * Per-agent node routing: the C1 harness installs ONE templated bundle into
 * both agents, so the bundle cannot bake a per-agent Kubo URL. Each request
 * carries `X-Ad4m-Did`; the sidecar maps DID → Kubo node, giving genuinely
 * separate nodes behind identical templates.
 *
 * Configuration (environment):
 *   PORT         HTTP listen port                         (default 7793)
 *   NODE_URLS    comma-separated Kubo API URLs, one/node  (default http://127.0.0.1:5001)
 *   AGENT_NODES  optional JSON { "<did>": "<apiUrl>" }     (default: round-robin)
 *   PEER_NODES   "true" to swarm-connect all nodes on boot (default false)
 */

import http from "http";
import { SidecarState } from "./state.js";
import * as routes from "./routes.js";

// ---------------------------------------------------------------------------
// Tiny router: method + path-pattern → handler(req, res, params, body, query)
// ---------------------------------------------------------------------------

function buildRoutes(state) {
  return [
    { method: "GET", pattern: "/health", handler: routes.health(state) },
    { method: "GET", pattern: "/messages", handler: routes.getMessages(state) },
    { method: "POST", pattern: "/publish", handler: routes.publish(state) },
    { method: "POST", pattern: "/kubo/dag/put", handler: routes.dagPut(state) },
    { method: "POST", pattern: "/kubo/dag/get", handler: routes.dagGet(state) },
    { method: "POST", pattern: "/kubo/pin/add", handler: routes.pinAdd(state) },
    { method: "POST", pattern: "/kubo/name/publish", handler: routes.namePublish(state) },
    { method: "POST", pattern: "/kubo/name/resolve", handler: routes.nameResolve(state) },
    { method: "POST", pattern: "/kubo/key/gen", handler: routes.keyGen(state) },
    { method: "POST", pattern: "/kubo/key/list", handler: routes.keyList(state) },
  ];
}

function matchRoute(routeList, method, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routeList) {
    if (route.method !== method) continue;
    const patSegs = route.pattern.split("/").filter(Boolean);
    if (patSegs.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      if (patSegs[i].startsWith(":")) {
        params[patSegs[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (patSegs[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * Create the HTTP server (without listening) — used by tests to drive the
 * sidecar on an ephemeral port.
 * @param {SidecarState} state
 * @returns {http.Server}
 */
export function createServer(state) {
  const routeList = buildRoutes(state);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const match = matchRoute(routeList, req.method, url.pathname);
      if (!match) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
        return;
      }
      const body =
        req.method === "POST" || req.method === "PUT" || req.method === "DELETE"
          ? await readBody(req)
          : undefined;
      await match.handler(req, res, match.params, body, url.searchParams);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `internal: ${e && e.message}` }));
      }
    }
  });

  // The in-sandbox client (the executor's hyper-based httpFetch) keeps a
  // connection pool and polls GET /messages on the executor's sync cadence
  // (a few seconds apart). Node's DEFAULT keepAliveTimeout is 5s: if the
  // server closes an idle pooled socket first, the client's very next request
  // races the FIN and hyper reports "connection closed before message
  // completed" — dropping exactly the poll that would have carried a peer's
  // inline commit, so convergence stalls. Keep the SERVER's idle window far
  // longer than any client poll interval so the CLIENT is always the side that
  // retires an idle connection (which is race-free). headersTimeout must stay
  // above keepAliveTimeout or Node would reap the socket on the header clock.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0; // never time a slow request out from under a handler
  return server;
}

/**
 * Swarm-connect every node to every other node so their pubsub meshes join.
 * Best-effort: logs failures but never blocks startup. Uses each node's own
 * reported swarm addresses, preferring a routable (non-loopback) address.
 * @param {SidecarState} state
 */
export async function peerNodes(state) {
  if (state.nodeUrls.length < 2) return;
  const ids = [];
  for (const url of state.nodeUrls) {
    try {
      const info = await state.clientForNode(url).id();
      ids.push({ url, id: info.id, addresses: info.addresses });
    } catch (e) {
      console.log(`[ipfs-sidecar] peerNodes: id() failed for ${url}: ${e.message}`);
      ids.push({ url, id: null, addresses: [] });
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j || !ids[j].id) continue;
      const addr = pickDialAddr(ids[j].addresses, ids[j].id);
      if (!addr) continue;
      try {
        await state.clientForNode(ids[i].url).swarmConnect(addr);
      } catch (e) {
        console.log(`[ipfs-sidecar] peerNodes: ${ids[i].url} -> ${addr} failed: ${e.message}`);
      }
    }
  }
}

/**
 * Choose a dialable multiaddr for a peer: prefer a non-loopback TCP swarm addr
 * that already carries /p2p/<id>; else append /p2p/<id> to a bare addr.
 */
function pickDialAddr(addresses, peerId) {
  const tcp = addresses.filter(
    (a) => a.includes("/tcp/") && !a.startsWith("/ip4/127.") && !a.includes("/ip6/"),
  );
  const withP2p = tcp.find((a) => a.includes("/p2p/"));
  if (withP2p) return withP2p;
  if (tcp.length > 0) return `${tcp[0]}/p2p/${peerId}`;
  return null;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const port = parseInt(process.env.PORT || "7793", 10);
  const nodeUrls = (process.env.NODE_URLS || "http://127.0.0.1:5001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let agentNodes = {};
  if (process.env.AGENT_NODES) {
    try {
      agentNodes = JSON.parse(process.env.AGENT_NODES);
    } catch {
      console.log("[ipfs-sidecar] AGENT_NODES is not valid JSON — ignoring");
    }
  }

  const state = new SidecarState(nodeUrls, agentNodes);
  const server = createServer(state);

  server.listen(port, async () => {
    console.log(
      `[ipfs-sidecar] listening on http://0.0.0.0:${port} (nodes: ${nodeUrls.join(", ")})`,
    );
    if (process.env.PEER_NODES === "true") {
      await peerNodes(state);
      console.log("[ipfs-sidecar] nodes peered");
    }
  });

  const shutdown = () => {
    console.log("[ipfs-sidecar] shutting down…");
    server.close();
    state.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
