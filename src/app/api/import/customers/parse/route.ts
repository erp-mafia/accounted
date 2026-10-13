import { parseCustomersFile } from '@/lib/import/customers/parser'
import { normalizeOrgNumber } from '@/lib/import/shared/column-utils'
import { createRegisterMatcher, customerMatchRow } from '@/lib/import/shared/register-match'
import { registerParseRoute } from '@/lib/import/shared/register-parse-route'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { AnnotatedCustomerRow, DetectedCustomerColumns, ParsedCustomerRow } from '@/lib/import/customers/types'

/**
 * POST /api/import/customers/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses rows,
 * and annotates each row with any duplicate-match against existing customers.
 */
export const POST = registerParseRoute<DetectedCustomerColumns, ParsedCustomerRow, AnnotatedCustomerRow>({
  operation: 'register_import.customers.parse',
  register: 'customer',
  parse: parseCustomersFile,
  async annotate(supabase, companyId, rows) {
    const existing = await fetchAllRows(({ from, to }) =>
      supabase
        .from('customers')
        .select('id, name, customer_number, org_number, email, customer_type')
        .eq('company_id', companyId)
        .range(from, to),
    )

    // The same matcher execute uses, so the preview cannot promise a match
    // the import then misses.
    const matcher = createRegisterMatcher(existing, { orgKey: normalizeOrgNumber })

    let duplicateCount = 0
    const annotated: AnnotatedCustomerRow[] = rows.map((r) => {
      const found = matcher.find(customerMatchRow(r))
      const match: AnnotatedCustomerRow['duplicate_match'] = found && !found.possible
        ? { customer_id: found.record.id, matched_by: found.matched_by, existing_name: found.record.name }
        : null
      const possible: AnnotatedCustomerRow['possible_duplicate'] = found?.possible
        ? { customer_id: found.record.id, existing_name: found.record.name }
        : null
      if (match) duplicateCount++
      return { ...r, duplicate_match: match, possible_duplicate: possible }
    })
    return { rows: annotated, duplicateCount }
  },
})
