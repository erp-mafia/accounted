/**
 * Registering the dimension codes already on journal lines ("Importera
 * befintliga koder"): every {sie_dim_no: code} pair found in
 * journal_entry_lines.dimensions without a registry row gets one, archived
 * (is_active false) and named by its code, so the registry is complete for
 * the history without filling the pickers. A dimension number no registry
 * row has (tagged through raw v1 JSON or MCP before the register existed)
 * gets its dimension too, so no code is skipped. Idempotent: a second run
 * creates nothing.
 *
 * It is part of turning dimensions on: lib/company/settings-service.ts runs
 * it when company_settings.dimensions_enabled goes from off to on, so every
 * door that can flip the flag (the settings page, v1 PATCH /settings, MCP
 * gnubok_update_company_settings) gets it. POST /api/dimensions/import-existing
 * runs it again on request.
 */
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

interface LineRow {
  id: string
  dimensions: Record<string, string> | null
}

export async function importExistingDimensionCodes(
  ctx: Pick<OperationContext, 'supabase' | 'companyId' | 'log'>,
): Promise<OperationOutcome<{ created: number }>> {
  const { supabase, companyId, log } = ctx

  const { error: ensureError } = await supabase.rpc('ensure_company_dimensions', {
    p_company_id: companyId,
  })
  if (ensureError) {
    log.error('ensure_company_dimensions failed', ensureError)
    return { ok: false, code: 'UNKNOWN_ERROR', error: ensureError }
  }

  try {
    // 1. Collect every {dim_no: code} pair used on this company's lines.
    //    journal_entry_lines has no company_id column, so the scope comes
    //    from the parent entries. Driving the query from that side
    //    (lib/bookkeeping/entry-lines.ts) instead of a
    //    `journal_entries!inner(company_id)` embed keeps PostgREST from
    //    compiling a correlated LATERAL join that walks every tenant's
    //    lines. The parent is not read here, so it is not reattached.
    const lines = await fetchEntryLines<LineRow>({
      supabase,
      lineColumns: 'id, dimensions',
      filterEntries: (q: EntryLinesQuery) => q.eq('company_id', companyId),
      filterLines: (q: EntryLinesQuery) => q.neq('dimensions', '{}'),
      attachEntriesAs: null,
    })

    const codesByDimNo = new Map<number, Set<string>>()
    for (const line of lines) {
      if (!line.dimensions) continue
      for (const [key, code] of Object.entries(line.dimensions)) {
        const dimNo = Number(key)
        if (!Number.isInteger(dimNo) || dimNo < 1) continue
        if (typeof code !== 'string' || code.length === 0) continue
        // Sanitize exactly like the PR1 substrate backfill
        // (left(regexp_replace(code, '["{}]', '', 'g'), 40)) so candidates
        // satisfy the dimension_values code CHECK; codes that sanitize to
        // empty are dropped, and the Set de-duplicates post-sanitization.
        const sanitized = code.replace(/["{}]/g, '').slice(0, 40)
        if (sanitized.length === 0) continue
        const set = codesByDimNo.get(dimNo) ?? new Set<string>()
        set.add(sanitized)
        codesByDimNo.set(dimNo, set)
      }
    }

    if (codesByDimNo.size === 0) return { ok: true, data: { created: 0 } }

    // 2. Registry state: dim_no → dimension_id, plus existing value codes.
    const { data: dims, error: dimsError } = await supabase
      .from('dimensions')
      .select('id, sie_dim_no')
      .eq('company_id', companyId)
    if (dimsError) throw dimsError

    const dimIdByNo = new Map<number, string>(
      ((dims ?? []) as { id: string; sie_dim_no: number }[]).map((d) => [d.sie_dim_no, d.id]),
    )

    // 3. Create registry rows for dim numbers seen on lines but missing from
    //    the registry (written via raw v1 JSON / MCP before the register
    //    existed). is_system=false; the user can rename them afterwards.
    const missingDimNos = [...codesByDimNo.keys()].filter((n) => !dimIdByNo.has(n))
    if (missingDimNos.length > 0) {
      // ignoreDuplicates: a concurrent creator (double-click, MCP) must not
      // abort the whole batch with a 23505: the survivor's row wins.
      const { data: createdDims, error: createDimsError } = await supabase
        .from('dimensions')
        .upsert(
          missingDimNos.map((n) => ({
            company_id: companyId,
            sie_dim_no: n,
            name: `Dimension ${n}`,
            is_system: false,
          })),
          { onConflict: 'company_id,sie_dim_no', ignoreDuplicates: true },
        )
        .select('id, sie_dim_no')
      if (createDimsError) throw createDimsError
      for (const d of (createdDims ?? []) as { id: string; sie_dim_no: number }[]) {
        dimIdByNo.set(d.sie_dim_no, d.id)
      }
    }

    // Every registered value, paged: the companies that need this most carry
    // thousands, past PostgREST's silent 1000-row cap.
    const existingValues = await fetchAllRows<{ dimension_id: string; code: string }>(({ from, to }) =>
      supabase
        .from('dimension_values')
        .select('dimension_id, code')
        .eq('company_id', companyId)
        .order('dimension_id', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to),
    )
    const existing = new Set(existingValues.map((v) => `${v.dimension_id}\0${v.code}`))

    // 4. Insert the missing values. name = code (the line map carries no
    //    display name), is_active = false so pickers stay clean until the
    //    user promotes the codes they still use.
    const inserts: Array<{
      company_id: string
      dimension_id: string
      code: string
      name: string
      is_active: boolean
    }> = []
    for (const [dimNo, codes] of codesByDimNo) {
      const dimensionId = dimIdByNo.get(dimNo)
      if (!dimensionId) continue
      for (const code of codes) {
        if (existing.has(`${dimensionId}\0${code}`)) continue
        inserts.push({
          company_id: companyId,
          dimension_id: dimensionId,
          code,
          name: code,
          is_active: false,
        })
      }
    }

    // Upsert with ignoreDuplicates so one duplicate row (raced insert, or a
    // code the existing-values snapshot missed) skips instead of aborting
    // the whole batch with a 23505. `created` counts the rows actually
    // inserted: the returned set excludes ignored duplicates.
    let created = 0
    if (inserts.length > 0) {
      const { data: insertedValues, error: insertError } = await supabase
        .from('dimension_values')
        .upsert(inserts, {
          onConflict: 'company_id,dimension_id,code',
          ignoreDuplicates: true,
        })
        .select('id')
      if (insertError) throw insertError
      created = (insertedValues ?? []).length
    }

    return { ok: true, data: { created } }
  } catch (err) {
    log.error('dimension import-existing failed', err as Error)
    return { ok: false, code: 'DIMENSION_IMPORT_FAILED', details: { reason: getUserErrorMessage(err) } }
  }
}
