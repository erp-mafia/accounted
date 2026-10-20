import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { fetchOverviewRowsForCompanies } from '../fetch-client-overview'

const db = createTableMockSupabase()
const supabase = db.supabase as unknown as SupabaseClient

const companies = [
  { id: 'c-1', name: 'Alpha AB', org_number: '5560125790' },
  { id: 'c-2', name: 'Beta AB', org_number: null },
]

/** companies is read twice: the customer numbers, and the latest verifikat per company. */
function companiesTable(clientNumbers: { data?: unknown; error?: { message: string } }) {
  db.setTable('companies', (chain) => {
    const projection = String(chain.find((c) => c.method === 'select')?.args[0] ?? '')
    return projection.includes('byra_client_number') ? clientNumbers : { data: [] }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  for (const table of ['company_settings', 'transactions', 'invoice_inbox_items', 'deadlines']) {
    db.setTable(table, { data: [] })
  }
})

describe('fetchOverviewRowsForCompanies: the byrå customer number', () => {
  it("carries each client's number, null where none is set", async () => {
    companiesTable({ data: [{ id: 'c-1', byra_client_number: 'K-1042' }, { id: 'c-2', byra_client_number: null }] })
    const rows = await fetchOverviewRowsForCompanies(supabase, companies)
    expect(Object.fromEntries(rows.map((r) => [r.companyId, r.clientNumber]))).toEqual({ 'c-1': 'K-1042', 'c-2': null })
    expect(db.payloads('companies', 'select')).toContain('id, byra_client_number')
  })

  it('leaves the numbers empty instead of failing the overview when the read fails', async () => {
    companiesTable({ error: { message: 'column companies.byra_client_number does not exist' } })
    const rows = await fetchOverviewRowsForCompanies(supabase, companies)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.clientNumber === null)).toBe(true)
  })
})
