/**
 * When the migration wizard may go straight from the preview to the options
 * step without showing its account mapping page.
 */

import { obsAccountsOf } from '@/lib/import/sie-preview-mappings'

/** The fields of a /sie-data mapping row, after the wizard's VAT enrichment, that this reads. */
export interface MappingStepRow {
  sourceAccount: string
  targetAccount: string
  matchType: string
  requiresVatTreatmentReview?: boolean
  vatTreatmentReviewed?: boolean
}

/**
 * The page is skipped only when it has nothing to ask: no blank target, no
 * VAT treatment waiting for confirmation, and no class 9 account the server
 * sent to 2999 OBS-konto. That last one is a suggestion made from the file's
 * usage (sie-preview-mappings.ts) and is posted as is once the import runs,
 * so the page shows it for review instead of applying it unseen (#3312).
 * A run where every file is already imported has nothing to map.
 */
export function canSkipMappingStep(
  rows: readonly MappingStepRow[],
  { unmapped, allImported = false }: { unmapped: number; allImported?: boolean },
): boolean {
  if (allImported) return true
  if (unmapped > 0) return false
  if (rows.some((row) => row.requiresVatTreatmentReview && !row.vatTreatmentReviewed)) return false
  return obsAccountsOf(rows).length === 0
}
