/**
 * Pure preview of what the SIE import does to the company's chart of
 * accounts. Client-safe (types only): the import wizard recomputes it in the
 * browser after "Skapa saknade konton", and the parse route computes it on
 * the server. The insert itself lives in account-sync.ts (syncMappedAccounts).
 */

import type { AccountMapping } from './types'

/** How many accounts are shown by number in the preview's chart card. */
export const CHART_SAMPLE_SIZE = 8

export interface ChartPlan {
  /** Distinct mapped target accounts absent from chart_of_accounts today. */
  toCreate: number
  /** Distinct mapped target accounts already present in chart_of_accounts. */
  existing: number
  /** First few accounts that will be created, for the preview card. */
  sample: { number: string; name: string }[]
}

/**
 * Split the distinct target accounts of `mappings` into those absent from the
 * company's chart and those already present.
 *
 * Only mapped accounts count: syncMappedAccounts inserts targets, and the
 * import refuses to run while any account is unmapped. An unmapped source is
 * therefore neither "läggs till" nor "finns redan"; it stays in the card's
 * "Ej mappade" count until the user creates it or maps it.
 *
 * Counts targets, not sources, so two sources remapped onto one target count
 * once, the same way the insert pass dedupes.
 *
 * The sample shows the name the import will give the account: the file's
 * #KONTO name for an identity mapping (the default, "Använd kontonamn från
 * filen" on), else the BAS name the mapping resolved to.
 */
export function planChartChanges(
  mappings: AccountMapping[],
  existingNumbers: ReadonlySet<string>,
): ChartPlan {
  const seen = new Set<string>()
  const toCreate: { number: string; name: string }[] = []
  let existing = 0

  for (const m of mappings) {
    const number = m.targetAccount
    if (!number || seen.has(number)) continue
    seen.add(number)
    if (existingNumbers.has(number)) {
      existing += 1
    } else {
      const fileName = m.sourceName?.trim()
      const name =
        m.sourceAccount === m.targetAccount && fileName ? fileName : m.targetName || fileName || ''
      toCreate.push({ number, name })
    }
  }

  toCreate.sort((a, b) => a.number.localeCompare(b.number))

  return {
    toCreate: toCreate.length,
    existing,
    sample: toCreate.slice(0, CHART_SAMPLE_SIZE),
  }
}
