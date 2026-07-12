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
fixtures. **Not** in CI: a live IPFS node (Kubo API on `:5001`), real IPNS
publish/resolve latency, and PubSub head propagation across agents.

## Gotchas

- IPNS is a *head pointer*, not the revision. The revision is a hash of the DAG
  head CIDs; IPNS sequence numbers must never leak into `currentRevision()`.
- PubSub is experimental in Kubo and best-effort — head convergence must not
  depend on delivery; the IPNS/parent-walk path is authoritative.
