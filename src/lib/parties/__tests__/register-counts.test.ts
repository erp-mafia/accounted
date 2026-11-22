import { describe, expect, it } from 'vitest'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { getRegister } from '../register'

/**
 * The register's reads page through PostgREST (fetchAllRows), and paging is
 * only correct on a total order: without one, rows on a page boundary are
 * duplicated or skipped, and the roles drift.
 */
describe('getRegister counts past 1,000 rows', () => {
  it("reads every party past one page, each paged read ordered on its unique id, and no invoice register at all", async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      parties: manyRows(1001, (i) => ({
        id: `p-${i}`, display_name: `Kund ${i} AB`, org_number: null, kind: 'company', status: 'confirmed',
        alias_keys: [], suggested_reason: null, created_at: '2026-01-01', archived_at: null,
      })),
      customers: [{ id: 'c-1', party_id: 'p-0' }],
    })

    const register = await getRegister(supabase as never, 'company-1', { view: 'all' })

    expect(register.rows).toHaveLength(1001)
    expect(register.rows.find((r) => r.id === 'p-0')?.roles.customerId).toBe('c-1')
    for (const table of ['parties', 'customers', 'suppliers', 'party_facts']) {
      expect(findCalls(table, 'order').map((a) => a[0])).toContain('id')
    }
    // The list never showed an invoice count, and reading it paged through
    // every invoice of the company (31 600 for the largest in production).
    expect(findCalls('invoices', 'select')).toEqual([])
    expect(findCalls('supplier_invoices', 'select')).toEqual([])
  })
})
