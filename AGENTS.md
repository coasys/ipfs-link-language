# AGENTS.md — ipfs-link-language

AD4M link language that stores a Perspective as a **content-addressed multi-parent
diff-DAG in IPLD**, pins it to IPFS, and advertises per-agent DAG heads over IPNS.

## Architecture (the load-bearing idea)

- **Role A — convergence substrate (source of truth).** An IPLD DAG of diff
  blocks. Each block is a PerspectiveDiff (link additions + tombstone removals
  carrying the original link hash) plus CID links to its parent block(s), so
  concurrent writers form a multi-parent DAG. Blocks are named by CID
  (content-addressed) and pinned. Merge folds an **OR-Set keyed by link hash**
  over the DAG.
- **Role B — native projection (derived).** None beyond the raw IPLD objects —
  IPFS has no human-app idiom to render into. The local link cache is a derived
  read model of the folded DAG.

Invariants — do not break these:

- `currentRevision()` is a **content hash of the DAG head CID(s)** — the single
  head CID when one head, else a deterministic digest of the sorted per-agent head
  CIDs. **Never** an IPNS sequence number, a timestamp, or a pin count.
- Removals are **tombstone entries carrying the original link hash**, never an
  `ipfs block rm` / unpin of the add.
- Sync **walks parent CIDs** from the advertised heads, fetches missing ancestor
  blocks, and re-folds — never diffs a snapshot listing.

## Cross-node transport — the pubsub-bridge sidecar (load-bearing)

Convergence across genuinely separate Kubo nodes rides **pubsub, not bitswap**.
On Kubo 0.42.0 two directly-peered nodes never negotiate a bitswap block
transfer, so a peer's commit *block* is unfetchable cross-node (`dag/get` for a
peer-only CID hangs on the daemon's ~30–50 s internal timeout). Two pieces
bridge it:

- **`gateway/` — a Node.js sidecar** (authored in `.js`, no build step — its
  files ARE the source; `gateway/.gitignore` re-includes `*.js` because the
  repo root ignores compiled JS). It holds Kubo's long-lived `pubsub/sub`
  receive stream (the executor's buffering `httpFetch` cannot), exposes a
  pollable `GET /messages?topic&since`, forwards unary Kubo ops verbatim, and
  routes each request to the DID's own node via the `X-Ad4m-Did` header — so one
  templated bundle drives two nodes. Run: `cd gateway && npm start` (`:7793`);
  test: `npm test` (7 tests). Keep `keepAliveTimeout` high (see gotcha below).
- **Inline-diff transport (`src/sidecar.ts`).** Each commit's **full body** is
  published inline over a per-neighbourhood diff topic; peers cache by CID and
  fold from cache. Blocks are still written locally so each node's own head CID
  is real — only *cross-node fetch* is replaced.

**Merge commits MUST be published inline too.** A merge commit carries no new
diff but IS an ancestor of the next commit, so a peer building on it would force
an unfetchable cross-node `dag/get`. `sync.ts converge()` takes a `publishMerge`
callback and inline-publishes the merge body **before** advancing IPNS
(`index.ts publishMergeInline`). Do not remove this — without it, adds converge
but removals stall on the merge-parent fetch.

## Layout

- `src/cid.ts` — CIDv1 construction + content hashing.
- `src/ipld.ts` — IPLD block encode/decode (dag-cbor diff blocks).
- `src/perspective-dag.ts` — the diff-DAG model: build blocks, walk parents,
  compute heads, fold to link set.
- `src/ipfs-api.ts` — Kubo HTTP API calls (block put/get, pin, dag).
- `src/pinning.ts` — pin management for durability.
- `src/pubsub.ts` — IPFS PubSub head announcement / receipt.
- `src/sync.ts` — head discovery (IPNS/PubSub) → parent walk → re-fold → diff.
- `src/translate.ts` — link ↔ diff-block translation.
- `src/store.ts` — derived link cache + query indexes.
- `src/{settings,types}.ts` — settings + shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected Transport / Storage /
  Runtime / Signing; `ad4m:host` imports confined to `adapters-deno.ts` +
  `index.ts`.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
runs `node:test` via tsx; the summary lines are `ℹ tests N` / `ℹ pass N` /
`ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic (no network): CID/IPLD encoding, the multi-parent DAG fold, OR-Set
merge, revision stability, and order-independence — all against in-memory
fixtures. The sidecar has 7 `node:test` tests (`gateway/npm test`) covering
topic encoding, per-DID routing, dag round-trip, and inline-diff cross-node
delivery.

**Live-verified (AD4M C1, `ad4m-wind-tunnel`):** two genuinely separate Kubo
nodes (`:5001`/`:5002`, distinct blockstores) behind one sidecar reached
**20/20 links in ~4.0 s** with a removal converging in **~6.1 s** (reproduced
across consecutive runs). This is the ONLY thing that exercised the transport
path; all four gotchas below were transport defects invisible to the unit
suites and only exposed by the live two-node run.

## Gotchas

- **Bitswap does not cross-node on Kubo 0.42.0.** A peer-only block's `dag/get`
  hangs ~30–50 s. Convergence rides pubsub inline-diffs, not block fetch; the
  sidecar's `dag/get` relay is bounded with a 3 s `AbortController` timeout so
  any stray cross-node fetch fails fast and `walkDag` skips it.
- **Merge commits must be inline-published** (see transport section) — else a
  peer's child-of-merge commit forces the unfetchable fetch and removals stall.
- **Deno sandbox denies env access (`allow_env:none`).** A *keyed* `process.env.X`
  read routes through `Deno.env.get`, throws `NotCapable`, and aborts the WHOLE
  bundle evaluation. Never read env at runtime in the language; gate debug on
  compile-time constants. (`esbuild.ts`'s `process.env` is fine — build-time
  Node, not the sandbox.)
- **Node `keepAliveTimeout` race.** The sidecar's default 5 s idle window retired
  pooled sockets before the executor's hyper pool, so the next `/messages` poll
  raced the FIN → "connection closed before message completed" and dropped that
  poll's inline commit. Fixed: `server.keepAliveTimeout=120_000`
  (+ `headersTimeout=125_000`, `requestTimeout=0`) in `gateway/src/server.js`,
  plus a status-0 retry (≤3, 50 ms) on the idempotent GET/publish paths in
  `src/sidecar.ts`. Do not lower these below the poll interval.
- IPNS is a *head pointer*, not the revision. The revision is a hash of the DAG
  head CIDs; IPNS sequence numbers must never leak into `currentRevision()`.
- PubSub is experimental in Kubo and best-effort — head convergence must not
  depend on delivery; the IPNS/parent-walk path is authoritative.
