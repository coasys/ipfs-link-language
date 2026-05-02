/**
 * Pure LinkExpression ↔ DAG-JSON node translation — zero runtime deps.
 *
 * Implements bidirectional mapping per Spec §10:
 * - LinkExpression → IPLD LinkNode (DAG-JSON)
 * - IPLD LinkNode → LinkExpression
 *
 * The DAG-JSON representation preserves all fields for lossless round-trip.
 */

import type { LinkExpression, ExpressionProof } from "./types.js";

// ---------------------------------------------------------------------------
// IPLD Node Types (DAG-JSON)
// ---------------------------------------------------------------------------

/**
 * An AD4M LinkExpression as an IPLD DAG-JSON node.
 */
export interface LinkNode {
    type: "ad4m:LinkExpression";
    source: string;
    predicate: string;
    target: string;
    author: string;
    timestamp: string;
    proof: {
        signature: string;
        key: string;
    };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to an IPLD LinkNode (DAG-JSON).
 */
export function linkToNode(link: LinkExpression): LinkNode {
    return {
        type: "ad4m:LinkExpression",
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
        proof: {
            signature: link.proof?.signature || "",
            key: link.proof?.key || "",
        },
    };
}

/**
 * Convert an IPLD LinkNode (DAG-JSON) back to a LinkExpression.
 */
export function nodeToLink(node: LinkNode): LinkExpression {
    return {
        author: node.author,
        timestamp: node.timestamp,
        data: {
            source: node.source,
            target: node.target,
            predicate: node.predicate,
        },
        proof: {
            signature: node.proof?.signature || "",
            key: node.proof?.key || "",
        },
    };
}

/**
 * Compute a deterministic content key for a LinkExpression.
 * Used for deduplication and indexing.
 */
export function linkContentKey(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
    });
}

/**
 * Validate that a LinkNode has all required fields.
 */
export function isValidLinkNode(node: unknown): node is LinkNode {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    return (
        n.type === "ad4m:LinkExpression" &&
        typeof n.source === "string" &&
        typeof n.predicate === "string" &&
        typeof n.target === "string" &&
        typeof n.author === "string" &&
        typeof n.timestamp === "string" &&
        typeof n.proof === "object" &&
        n.proof !== null
    );
}

/**
 * Batch convert LinkExpressions to LinkNodes.
 */
export function linksToNodes(links: LinkExpression[]): LinkNode[] {
    return links.map(linkToNode);
}

/**
 * Batch convert LinkNodes to LinkExpressions.
 */
export function nodesToLinks(nodes: LinkNode[]): LinkExpression[] {
    return nodes.map(nodeToLink);
}
