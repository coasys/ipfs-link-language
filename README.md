# IPFS Link Language for AD4M

AD4M link language that syncs Perspective triples to IPFS via the Kubo HTTP API, stored as DAG-JSON objects.

## What It Does

- **Commits:** links → DAG-JSON objects put to IPFS via `dag/put`
- **Sync:** resolves IPNS name for new perspective diffs → local links
- **Query:** indexed local store (source, target, predicate)
- **Content-addressed:** every link is a CID-addressable DAG-JSON object
- **Merkle DAG:** perspective diffs form a hash-linked chain for verifiable history

## Template Variables

| Variable | Description |
|----------|-------------|
| `IPFS_API_URL` | Kubo HTTP API endpoint |
| `IPFS_GATEWAY_URL` | IPFS gateway URL for reads |
| `IPNS_NAME` | IPNS name for the perspective head |
| `PINNING_SERVICE_URL` | Remote pinning service URL |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

238 tests across 10 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/ipfs-api.ts` / `ipfs-api.pure.ts` — Kubo HTTP API (including multipart `dag/put`)
- `src/cid.ts` / `cid.pure.ts` — CID generation + validation
- `src/ipld.ts` / `ipld.pure.ts` — DAG-JSON encoding
- `src/perspective-dag.ts` / `perspective-dag.pure.ts` — Merkle DAG of perspective diffs
- `src/pinning.ts` — pin management
- `src/translate.ts` / `translate.pure.ts` — link ↔ DAG-JSON translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
