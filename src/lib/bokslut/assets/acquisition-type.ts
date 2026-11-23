/**
 * How an asset came onto the books (assets.acquisition_type). Pure and safe
 * in the browser: the register forms and the note on anläggningstillgångar
 * (ÅRL 5 kap. 8 §) read it, the API validates against it.
 *
 * The K2 taxonomy gives each its own row of the note per balance sheet post:
 * Inköp, Rörelseförvärv, Fusion and Omklassificeringar. An asset that came
 * in by merger or reclassification is registered with the day it came in as
 * its acquisition date, the depreciation taken over with it as its opening
 * accumulated depreciation, and what remains of its life from that day as
 * its useful life: the plan runs from the acquisition date over the useful
 * life (depreciation-engine.ts), so the full life from the original purchase
 * would spread what is left far too thin.
 */
import type { Asset, AssetAcquisitionType } from '@/types'

export const ASSET_ACQUISITION_TYPES = [
  'purchase',
  'business_acquisition',
  'merger',
  'reclassification',
] as const satisfies readonly AssetAcquisitionType[]

/** The asset's acquisition type; a row read before the column existed is a purchase. */
export function assetAcquisitionType(asset: Pick<Asset, 'acquisition_type'>): AssetAcquisitionType {
  return asset.acquisition_type ?? 'purchase'
}

/**
 * Whether an asset that came in this way brings accumulated depreciation
 * with it: a fusion or an omklassificering takes over what the asset had
 * been depreciated, a purchase or a rörelseförvärv starts from its price.
 * The register form asks for the amount when it does.
 */
export function arrivesDepreciated(type: AssetAcquisitionType): boolean {
  return type === 'merger' || type === 'reclassification'
}
