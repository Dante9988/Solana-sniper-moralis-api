/**
 * Back-compatible re-export.
 *
 * The pure protocol layer now lives at `src/pump/protocol/pumpSwap.ts`. This file stays so
 * existing importers keep working, and because the safe-to-import path is the whole point of
 * the separation — see that module's header for why it must not be folded into
 * `pumpswapService.ts`.
 *
 * Prefer importing from `src/pump/protocol/pumpSwap` in new code.
 */
export * from "../pump/protocol/pumpSwap";
