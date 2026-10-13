import { parseSuppliersFile } from '@/lib/import/suppliers/parser'
import { createRegisterMatcher, supplierOrgKey } from '@/lib/import/shared/register-match'
import { registerParseRoute } from '@/lib/import/shared/register-parse-route'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { AnnotatedSupplierRow, DetectedSupplierColumns, ParsedSupplierRow } from '@/lib/import/suppliers/types'

/**
 * POST /api/import/suppliers/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses rows,
 * and annotates each row with any duplicate-match against existing suppliers.
 */
export const POST = registerParseRoute<DetectedSupplierColumns, ParsedSupplierRow, AnnotatedSupplierRow>({
  operation: 'register_import.suppliers.parse',
  register: 'supplier',
  parse: parseSuppliersFile,
  async annotate(supabase, companyId, rows) {
    const existing = await fetchAllRows(({ from, to }) =>
      supabase
        .from('suppliers')
        .select('id, name, org_number, email')
        .eq('company_id', companyId)
        .range(from, to),
    )

    // The same matcher execute uses, so the preview cannot promise a match
    // the import then misses.
    const matcher = createRegisterMatcher(existing, { orgKey: supplierOrgKey })

    let duplicateCount = 0
    const annotated: AnnotatedSupplierRow[] = rows.map((r) => {
      const found = matcher.find(r)
      const match: AnnotatedSupplierRow['duplicate_match'] = found && !found.possible
        ? { supplier_id: found.record.id, matched_by: found.matched_by, existing_name: found.record.name }
        : null
      const possible: AnnotatedSupplierRow['possible_duplicate'] = found?.possible
        ? { supplier_id: found.record.id, existing_name: found.record.name }
        : null
      if (match) duplicateCount++
      return { ...r, duplicate_match: match, possible_duplicate: possible }
    })
    return { rows: annotated, duplicateCount }
  },
})
