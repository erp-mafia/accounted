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

  it('shows the org number through the one reader: an empty company copy hides nothing', async () => {
    companiesTable({ data: [] })
    db.setTable('company_settings', { data: [{ company_id: 'c-2', company_name: 'Beta AB', org_number: '556677-8899' }] })
    const rows = await fetchOverviewRowsForCompanies(supabase, [{ id: 'c-2', name: 'Beta AB', org_number: '' }])
    expect(rows[0]?.orgNumber).toBe('556677-8899')
    db.setTable('company_settings', { data: [{ company_id: 'c-2', company_name: 'Beta AB', org_number: '' }] })
    const other = await fetchOverviewRowsForCompanies(supabase, [{ id: 'c-2', name: 'Beta AB', org_number: '556677-8899' }])
    expect(other[0]?.orgNumber).toBe('556677-8899')
  })

  it('leaves the numbers empty instead of failing the overview when the read fails', async () => {
    companiesTable({ error: { message: 'column companies.byra_client_number does not exist' } })
    const rows = await fetchOverviewRowsForCompanies(supabase, companies)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.clientNumber === null)).toBe(true)
  })
})

describe('fetchOverviewRowsForCompanies: the attest queues', () => {
  beforeEach(() => {
    companiesTable({ data: [] })
    db.setTable('company_attest_policies', {
      data: [{ company_id: 'c-1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }],
    })
    db.setTable('supplier_invoices', {
      data: [
        { id: 'w-1', company_id: 'c-1', user_id: 'alex', status: 'overdue', approved_at: null, due_date: '2020-09-15', remaining_amount: 29625, auto_debit: false, is_credit_note: false, currency: 'SEK', total: 29625, total_sek: null, exchange_rate: null },
        { id: 'r-1', company_id: 'c-1', user_id: 'alex', status: 'approved', approved_at: '2026-10-31T10:00:00Z', due_date: '2999-11-19', remaining_amount: 11250, auto_debit: false, is_credit_note: false, currency: 'SEK', total: 11250, total_sek: null, exchange_rate: null },
      ],
    })
    db.setTable('supplier_payment_batch_items', { data: [] })
    db.setTable('payment_orders', { data: [] })
  })

  it('carries each client\'s queues when asked, null for a client without an attest step', async () => {
    db.setTable('company_settings', { data: [{ company_id: 'c-1', accounting_method: 'accrual' }] })
    const rows = await fetchOverviewRowsForCompanies(supabase, companies, { includeAttest: true })
    const byId = Object.fromEntries(rows.map((r) => [r.companyId, r.attest]))
    expect(byId['c-1']).toEqual({
      waiting: { count: 1, next_due: '2020-09-15', overdue: 1 },
      ready: { count: 1, next_due: '2999-11-19', overdue: 0 },
    })
    expect(byId['c-2']).toBeNull()
  })

  it('leaves the payload as it was when not asked, and the columns empty when the read fails', async () => {
    const plain = await fetchOverviewRowsForCompanies(supabase, companies)
    expect(plain.every((r) => !('attest' in r))).toBe(true)
    expect(db.findCall('company_attest_policies', 'select')).toBeUndefined()

    db.setTable('company_attest_policies', { error: { message: 'boom' } })
    const failed = await fetchOverviewRowsForCompanies(supabase, companies, { includeAttest: true })
    expect(failed).toHaveLength(2)
    expect(failed.every((r) => !('attest' in r))).toBe(true)
  })
})
