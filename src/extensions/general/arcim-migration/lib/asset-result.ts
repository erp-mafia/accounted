/**
 * How the wizard's result step reads the asset register import.
 *
 * Kept free of server imports (type-only below) because the workspace renders
 * it in the browser; import-assets.ts, which produces the counts, pulls in the
 * asset service and the provider client.
 */

import type { AssetSkipReasons } from '../types'

/**
 * Whether the asset row needs a detail line under its imported count.
 *
 * Skips need one, and so do assets imported on their category default
 * accounts because the source type could not be resolved. Those are counted
 * on assets that made it INTO the register, so a run where every asset
 * imported reports `skipped: 0` and still has something to say. Gating the
 * line on skips alone kept that warning silent in exactly that case, leaving
 * a register that does not tie to the ledger with no stated reason.
 */
export function assetResultNeedsDetail(result: {
  skipped: number
  skipReasons?: AssetSkipReasons
}): boolean {
  return result.skipped > 0 || (result.skipReasons?.typeUnresolved ?? 0) > 0
}
