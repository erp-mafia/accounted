import type { SupabaseClient } from '@supabase/supabase-js'
import { SIE_RESERVED_DIMENSIONS } from '@/lib/reports/sie-export'
import type { ParsedSIEFile } from './types'

/**
 * Registry-side of lossless SIE dimension import (dimensions plan PR5).
 *
 * Collects every dimension the file mentions: declared (#DIM/#UNDERDIM),
 * valued (#OBJEKT), or merely referenced by a #TRANS object list: and
 * inserts the missing `dimensions`/`dimension_values` rows. Existing rows
 * are NEVER touched (ON CONFLICT DO NOTHING): an import must not rename a
 * user's dimensions or values. Undeclared reserved numbers synthesize their
 * SIE-standard names (1 Kostnadsställe, 2→1 Kostnadsbärare, 6 Projekt, 7-10);
 * unknown customs fall back to "Dimension N", exactly mirroring the export's
 * orphan synthesis so a parse→import→re-export round-trip is lossless.
 *
 * Rows created here carry `created_by_import_id` so `undo_sie_import` can
 * remove registry values that the undone import introduced (and that nothing
 * else references): the lockstep the plan requires.
 */

export interface DimensionImportSummary {
  /** dimensions rows actually inserted (not pre-existing). */
  dimensionsCreated: number
  /** dimension_values rows actually inserted (not pre-existing). */
  valuesCreated: number
  /** #TRANS lines in the file carrying an object list. */
  taggedLines: number
  /** True when this import flipped company_settings.dimensions_enabled on. */
  toggleEnabled: boolean
  warnings: string[]
}

/** dimension_values.code DB CHECK: 1-40 chars, none of `"{}`. */
function isValidRegistryCode(code: string): boolean {
  return code.length >= 1 && code.length <= 40 && !/["{}]/.test(code)
}

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

  return { dims, values, taggedLines, invalidCodes }
}

/**
 * Upsert the registry rows the file needs and flip dimensions_enabled on.
 * Returns null when the file carries no dimension data at all: companies
 * without dimensions see literally nothing changed.
 */
export async function importDimensionRegistry(
  supabase: SupabaseClient,
  companyId: string,
  parsed: ParsedSIEFile,
  importId: string | null
): Promise<DimensionImportSummary | null> {
  const { dims, values, taggedLines, invalidCodes } = collectSIEDimensionUsage(parsed)
  if (dims.size === 0 && values.size === 0 && taggedLines === 0) {
    return null
  }

  const warnings: string[] = []
  if (invalidCodes.size > 0) {
    warnings.push(
      `${invalidCodes.size} dimensionskoder kunde inte registreras (ogiltig längd eller tecken): ` +
        [...invalidCodes].slice(0, 5).join(', ') +
        (invalidCodes.size > 5 ? '…' : '')
    )
  }

  // Seed system dims 1/6 (idempotent) before touching the registry.
  await supabase.rpc('ensure_company_dimensions', { p_company_id: companyId })

  // ── dimensions rows: insert missing, never rename existing ────
  let dimensionsCreated = 0
  if (dims.size > 0) {
    const dimInserts = [...dims.entries()].map(([sieDimNo, info]) => ({
      company_id: companyId,
      sie_dim_no: sieDimNo,
      parent_sie_dim_no: info.parent ?? null,
      name: info.name,
      // Dim 1 resets annually per SIE convention; projekt (6) accumulates.
      // ensure_company_dimensions already seeded 1/6 with the right flags,
      // so this only matters for custom dims: default to resetting.
      resets_annually: sieDimNo !== 6,
      is_system: false,
      created_by_import_id: importId,
    }))
    const { data: insertedDims, error: dimError } = await supabase
      .from('dimensions')
      .upsert(dimInserts, { onConflict: 'company_id,sie_dim_no', ignoreDuplicates: true })
      .select('id')
    if (dimError) {
      warnings.push(`Dimensionsregistret kunde inte uppdateras: ${dimError.message}`)
      return { dimensionsCreated: 0, valuesCreated: 0, taggedLines, toggleEnabled: false, warnings }
    }
    dimensionsCreated = insertedDims?.length ?? 0
  }

  // ── dimension_values rows ───────────────────────────────────────
  let valuesCreated = 0
  if (values.size > 0) {
    const { data: dimRows, error: readError } = await supabase
      .from('dimensions')
      .select('id, sie_dim_no')
      .eq('company_id', companyId)
      .in('sie_dim_no', [...new Set([...values.values()].map((v) => v.sieDimNo))])
    if (readError || !dimRows) {
      warnings.push(`Dimensionsvärden kunde inte registreras: ${readError?.message ?? 'okänt fel'}`)
      return { dimensionsCreated, valuesCreated: 0, taggedLines, toggleEnabled: false, warnings }
    }
    const dimIdByNo = new Map(dimRows.map((d) => [Number(d.sie_dim_no), d.id as string]))

    const valueInserts = [...values.values()]
      .filter((v) => dimIdByNo.has(v.sieDimNo))
      .map((v) => ({
        company_id: companyId,
        dimension_id: dimIdByNo.get(v.sieDimNo)!,
        code: v.code,
        name: v.name,
        created_by_import_id: importId,
      }))

    if (valueInserts.length > 0) {
      const { data: insertedValues, error: valueError } = await supabase
        .from('dimension_values')
        .upsert(valueInserts, {
          onConflict: 'company_id,dimension_id,code',
          ignoreDuplicates: true,
        })
        .select('id')
      if (valueError) {
        warnings.push(`Dimensionsvärden kunde inte registreras: ${valueError.message}`)
        return { dimensionsCreated, valuesCreated: 0, taggedLines, toggleEnabled: false, warnings }
      }
      valuesCreated = insertedValues?.length ?? 0
    }
  }

  // ── Auto-enable the toggle with a notice ────────────────────────
  // The column comment pre-authorizes this: "SIE import that finds dimensions
  // may flip this on with a notice." Idempotent; only reported as flipped
  // when it actually changed.
  let toggleEnabled = false
  const { data: settings } = await supabase
    .from('company_settings')
    .select('dimensions_enabled')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settings && settings.dimensions_enabled !== true) {
    const { error: toggleError } = await supabase
      .from('company_settings')
      .update({ dimensions_enabled: true })
      .eq('company_id', companyId)
    if (!toggleError) toggleEnabled = true
  }

  return { dimensionsCreated, valuesCreated, taggedLines, toggleEnabled, warnings }
}
