import { SIE_RESERVED_DIMENSIONS } from '@/lib/reports/sie-export'
import { isValidRegistryCode } from './sie-object-balances'
import type { ParsedSIEFile } from './types'

/**
 * Registry-side of lossless SIE dimension import (dimensions plan PR5).
 *
 * Collects every dimension the file mentions: declared (#DIM/#UNDERDIM),
 * valued (#OBJEKT), or merely referenced by a #TRANS object list. The SIE
 * job (sie-job-preparation.ts) inserts the missing `dimensions`/
 * `dimension_values` rows from this usage. Existing rows are NEVER touched
 * (ON CONFLICT DO NOTHING): an import must not rename a user's dimensions
 * or values. Undeclared reserved numbers synthesize their
 * SIE-standard names (1 Kostnadsställe, 2→1 Kostnadsbärare, 6 Projekt, 7-10);
 * unknown customs fall back to "Dimension N", exactly mirroring the export's
 * orphan synthesis so a parse→import→re-export round-trip is lossless.
 *
 * Rows the job creates carry `created_by_import_id` as provenance. Undoing the
 * import keeps them: the undo every door runs (request_sie_import_undo, then
 * undo_sie_import_chunk) is a batch storno, so the imported verifikat stay in
 * the ledger as reversed and their reversal lines copy each line's
 * dimensions. Both still reference these codes, and the registry must keep
 * declaring them (SIE #OBJEKT, report column names). The registry cleanup
 * belonged to the older delete-based undo_sie_import (migration
 * 20260702154500), which no door calls any more; only reset_fiscal_year
 * still removes import-created rows that no posted or reversed line
 * references.
 */

export function collectSIEDimensionUsage(parsed: ParsedSIEFile): {
  dims: Map<number, { name: string; parent?: number }>
  values: Map<string, { sieDimNo: number; code: string; name: string }>
  taggedLines: number
  invalidCodes: Set<string>
} {
  const dims = new Map<number, { name: string; parent?: number }>()
  const values = new Map<string, { sieDimNo: number; code: string; name: string }>()
  const invalidCodes = new Set<string>()
  let taggedLines = 0

  const ensureDim = (dimNo: number, name?: string, parent?: number) => {
    const existing = dims.get(dimNo)
    if (existing) {
      // A declared name/parent wins over a synthesized placeholder.
      if (name) existing.name = name
      if (parent !== undefined) existing.parent = parent
      return
    }
    const reserved = SIE_RESERVED_DIMENSIONS[dimNo]
    dims.set(dimNo, {
      name: name || reserved?.name || `Dimension ${dimNo}`,
      parent: parent ?? reserved?.parent,
    })
  }

  const ensureValue = (dimNo: number, code: string, name?: string) => {
    if (!isValidRegistryCode(code)) {
      invalidCodes.add(`${dimNo}:${code}`)
      return
    }
    ensureDim(dimNo)
    const key = `${dimNo} ${code}`
    const existing = values.get(key)
    if (existing) {
      if (name && existing.name === existing.code) existing.name = name
      return
    }
    values.set(key, { sieDimNo: dimNo, code, name: name || code })
  }

  // Nullish guards: ParsedSIEFile-shaped objects predating PR5 (serialized
  // previews, hand-built test fixtures) may lack the dimension arrays.
  for (const dim of parsed.dimensions ?? []) {
    ensureDim(dim.sieDimNo, dim.name || undefined, dim.parentSieDimNo)
  }
  for (const value of parsed.dimensionValues ?? []) {
    ensureValue(value.sieDimNo, value.code, value.name)
  }
  for (const voucher of parsed.vouchers ?? []) {
    for (const line of voucher.lines) {
      if (!line.dimensions) continue
      taggedLines++
      for (const [dimNoRaw, code] of Object.entries(line.dimensions)) {
        const dimNo = Number(dimNoRaw)
        if (!Number.isInteger(dimNo) || dimNo < 1) continue
        ensureValue(dimNo, code)
      }
    }
  }
  // Objects referenced by #OIB/#OUB (issue #3313): the IB entry tags its
  // lines with them, so the registry must know them before it posts. A code
  // the registry cannot hold is left out here rather than reported as
  // invalid: the IB split skips that row with its own preview note, and an
  // object balance must never fail an import that ignored it until now.
  for (const row of [...(parsed.objectOpeningBalances ?? []), ...(parsed.objectClosingBalances ?? [])]) {
    const dimNo = Number(row.dimNo)
    if (!Number.isInteger(dimNo) || dimNo < 1 || !isValidRegistryCode(row.code)) continue
    ensureValue(dimNo, row.code)
  }

  return { dims, values, taggedLines, invalidCodes }
}
