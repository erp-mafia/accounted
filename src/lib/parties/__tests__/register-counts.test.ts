import { describe, expect, it } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { getRegister } from '../register'

/**
 * The register's counts page through PostgREST (fetchAllRows), and paging is
 * only correct on a total order: without one, rows on a page boundary are
 * duplicated or skipped, and the invoice counts and roles drift.
 */
describe('getRegister counts past 1,000 rows', () => {
  it("counts every one of a customer's invoices, each paged read ordered on its unique id", async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      parties: [
        { id: 'p-1', display_name: 'Kund AB', org_number: null, kind: 'company', status: 'confirmed', alias_keys: [], suggested_reason: null, created_at: '2026-01-01', archived_at: null },
      ],
      customers: [{ id: 'c-1', party_id: 'p-1' }],
      invoices: manyRows(1001, () => ({ customer_id: 'c-1' })),
    })

    const register = await getRegister(supabase as never, 'company-1', { view: 'all' })

    expect(register.rows[0].invoiceCount).toBe(1001)
    for (const table of ['parties', 'customers', 'suppliers', 'invoices', 'supplier_invoices', 'party_facts']) {
      expect(findCalls(table, 'order').map((a) => a[0])).toContain('id')
    }
  })
})
