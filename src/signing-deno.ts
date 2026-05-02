/**
 * Deno-specific signing adapter implementation.
 * Wraps ad4m:host agent signing functions.
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import {
    agentSignStringHex,
    agentSigningKeyId,
} from "@coasys/ad4m-ldk";
import type { SigningAdapter } from "./signing-interface.js";

/**
 * Signing adapter for the Deno/JS executor runtime.
 * Delegates to `agentSignStringHex` and `agentSigningKeyId` from `ad4m:host`.
 */
export class DenoSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return agentSignStringHex(payload);
    }

    signingKeyId(): string {
        return agentSigningKeyId();
    }
}
