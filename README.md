# IPFS Link Language for AD4M

An AD4M link language that syncs a Perspective to IPFS as a **multi-writer,
hash-linked diff-DAG** via the Kubo HTTP API. Every commit is a content-addressed
DAG-JSON object; concurrent writers converge without a coordinator via an
observed-remove set (OR-Set) folded over the DAG.

## What It Does

- **Multi-parent commit DAG:** each commit is a DAG-JSON `PerspectiveCommitNode`
  whose `previous` is an **array** of parent CIDs. Linear history has one parent;
  a merge commit lists every head it reconciles. Genesis has `previous: []`.
- **Per-agent IPNS heads:** each agent publishes *its own* head CID under *its own*
  IPNS key. No shared mutable pointer, so concurrent publishers never clobber each
  other. The set of all current head CIDs is the replica frontier.
- **Head discovery:** agents announce `{ did, ipnsName, head }` over a Kubo PubSub
  head-announcement topic, so peers learn each other's IPNS names and seed head CIDs
  directly, then resolve those names to track the frontier.
- **OR-Set convergence:** materialised state is the union of all additions across the
  DAG minus all observed removals, keyed by link content hash. Because links are
  immutable content-addressed elements, the fold is commutative, associative, and
  idempotent — every replica computes the same link set regardless of delivery order.
- **First-class removals:** a removal is a diff entry carrying the **original link
  hash** it tombstones (the same hash the addition produced), so a remove on one
  replica reconciles against the matching add on another.
- **Merge commits on divergence:** when the frontier has more than one head, a merge
  commit is created whose `previous` lists all heads (sorted + deduped for
  determinism); its materialised state is the OR-Set union of the merged branches.
- **Content-hash revision:** `currentRevision` is always a content hash, never a
  cursor or timestamp. With a single head it is that head's CID; with multiple
  un-merged heads it is a deterministic digest of the sorted head CIDs (a
  version-vector digest); after a merge it is the merge commit's CID.
- **Telepresence:** real-time presence and signalling via Kubo PubSub
  (multibase-encoded topics for Kubo v0.41+ compatibility).

## Convergence guarantees (AD4M perspective-sync)

This language honours AD4M's `perspective-sync` contract as a genuine convergent
diff-DAG (not a single-writer log):

1. **Multi-parent DAG walk** reproduces the full link set — a BFS over all ancestors,
   deduped by CID, tolerant of not-yet-propagated peer blocks.
2. **Two divergent heads merge deterministically** — folding the branches in either
   order yields the same link set, and the merge commit's parent list (sorted +
   deduped) yields the same merge CID regardless of which agent merges.
3. **Removal convergence** — if agent A adds link `L` (hash `h`) and agent B removes
   `h`, after merge `L` is absent on both replicas; remove-before-add is
   order-independent.
4. **`currentRevision` is a content hash** — never a cursor/timestamp; identical
   frontiers produce identical revisions on every replica.

## Template Variables

| Variable | Description |
|----------|-------------|
| `IPFS_API_URL` | Kubo HTTP API endpoint |
| `IPFS_GATEWAY_URL` | IPFS gateway URL for reads |
| `IPNS_NAME` | This agent's IPNS name for publishing its own head |
| `PINNING_SERVICE_URL` | Remote pinning service URL |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
NODE_ENV=development pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.
The bundle is written to `build/bundle.js`. `ad4m:host` is marked external and
resolved by the executor at runtime.

## Testing

```bash
NODE_ENV=development node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

320 tests across 98 suites. The DAG walk, OR-Set fold, merge, and revision logic are
unit-tested in-process against a content-addressed mock of the IPFS API surface
(deterministic CIDs, `dag/put` / `dag/get` / `name/resolve`). See
`tests/convergence.test.ts` for the perspective-sync acceptance criteria and
`tests/sync.test.ts` for frontier convergence and merge-commit creation.

> **Live-node note:** cross-agent convergence over *real* IPFS/IPNS (peers publishing
> to their own IPNS keys, PubSub head announcements propagating, name resolution)
> requires a running Kubo daemon and is not exercised by the unit suite. The
> convergence *logic* is fully covered against the IPFS API surface; wiring against a
> live daemon is an integration concern.

## Architecture

The core modules carry no `ad4m:host` imports; the host-facing adapters
(Transport, Storage, Runtime, Signing) live in the two adapter files and are only
imported by `index.ts`.

- `src/ipfs-api.ts` — Kubo HTTP API (including multipart `dag/put`)
- `src/cid.ts` — CID generation + validation
- `src/ipld.ts` — DAG-JSON (deterministic sorted-key) encoding
- `src/perspective-dag.ts` — the convergence substrate: multi-parent commit DAG,
  head/frontier management, per-agent IPNS bookkeeping, DAG walk, OR-Set fold,
  merge-commit construction, content-hash revision
- `src/sync.ts` — frontier-based convergence: peer-head discovery, walk → fold →
  apply, tip resolution, merge-on-divergence
- `src/pubsub.ts` — PubSub telepresence + head-announcement topic (presence,
  signals, `{ did, ipnsName, head }` announcements, multibase topic encoding)
- `src/store.ts` — indexed local link store (source, target, predicate) + revision
- `src/translate.ts` — link ↔ DAG-JSON translation, pattern detection
- `src/pinning.ts` — pin management
- `src/settings.ts` — language settings
- `src/types.ts` — shared types
- `src/adapters.ts` / `src/adapters-deno.ts` — injected host adapters

## License

CAL-1.0
