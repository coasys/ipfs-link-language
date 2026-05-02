/**
 * Dual-language deduplication — pure module.
 *
 * When the IPFS Link Language operates alongside a primary link language
 * (e.g. Holochain), we need to:
 * - Deduplicate links that arrive via both IPFS and native sync
 * - Track which links originated from IPFS vs native
 * - Filter outbound publication for links that arrived via IPFS
 *   (to avoid echo/re-publication loops)
 *
 * Spec §12.
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "ipfs" | "native" | "dual";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a canonical content key for dedup comparison.
 * Uses triple only (source, predicate, target) — intentionally
 * excludes author/timestamp so the same logical link from different
 * sync paths is detected as a duplicate.
 */
function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be published to IPFS.
 *
 * Links that originated from IPFS should NOT be re-published to avoid
 * echo loops. Only "native" or "dual" origin links (or links with
 * no tracked origin, i.e. new local commits) should be published.
 */
export function shouldPublish(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "ipfs";
}

/**
 * Check if a predicate should be excluded from IPFS publication.
 */
export function isExcludedPredicate(
    predicate: string | undefined,
    excludePredicates: string[],
): boolean {
    if (!predicate) return false;
    return excludePredicates.includes(predicate);
}
