/**
 * GET /api/transactions/migration-coverage: which open rows carry the
 * "från perioden före din migrering" marker (crm#1239).
 *
 * The detector is NOT mocked: the regression is that rows inside the old
 * system's period were marked "most likely already imported" on their date
 * alone, so the test runs the real explaining-set detector over a ledger
 * where one row is booked (as two vouchers) and the others are not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, setTable, reset, tables, findCall } = createTableMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

type Body = { data: { coverage_end: string | null; explained_ids: string[] } }

const COVERAGE_END = '2026-10-16'

const openRow = (id: string, date: string, amount: number) => ({
  id,
  date,
  amount,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  cash_account_id: 'ca-1',
})

const entry = (id: string, date: string) => ({
  id,
  entry_date: date,
  description: `Voucher ${id}`,
  voucher_series: id[0],
  voucher_number: Number(id.slice(1)),
  status: 'posted',
  source_type: 'import',
  company_id: 'company-1',
})

/** The ledger around the open rows: E19 + E20 pay one bank row together, A95 is a fee already linked. */
const LEDGER = {
  entries: [entry('E19', '2026-09-30'), entry('E20', '2026-09-30'), entry('A95', '2026-09-18')],
  lines: [
    { id: 'l-1', journal_entry_id: 'E19', account_number: '1930', debit_amount: 0, credit_amount: 999 },
    { id: 'l-2', journal_entry_id: 'E20', account_number: '1930', debit_amount: 0, credit_amount: 6875 },
    { id: 'l-3', journal_entry_id: 'A95', account_number: '1930', debit_amount: 0, credit_amount: 1.85 },
  ],
}

/**
 * The ledger scan is one read, get_unexplained_bank_legs: the legs nothing
 * explains yet (A95 is linked to an earlier bank row, so it is not among
 * them; the read's rules are tested against Postgres in
 * tests/pg/bank-reconciliation-facts.pg.test.ts).
 */
function seedMigratedCompany(rows: ReturnType<typeof openRow>[], ledger = LEDGER) {
  setTable('sie_imports', { data: { id: 'import-1' } })
  setTable('journal_entries', { data: { entry_date: COVERAGE_END } })
  setTable('rpc:get_unexplained_bank_legs', {
    data: ledger.lines
      .filter((l) => l.journal_entry_id !== 'A95')
      .map((l) => {
        const e = ledger.entries.find((x) => x.id === l.journal_entry_id)!
        return {
          journal_entry_id: e.id,
          entry_date: e.entry_date,
          description: e.description,
          voucher_series: e.voucher_series,
          voucher_number: e.voucher_number,
          status: e.status,
          source_type: e.source_type,
          account_number: l.account_number,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
        }
      }),
  })
  setTable('cash_accounts', { data: [{ id: 'ca-1', ledger_account: '1930' }] })
  setTable('transactions', { data: rows })
}

describe('GET /api/transactions/migration-coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.se' } }, error: null })
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await GET(createMockRequest('/api/transactions/migration-coverage'), {
      params: Promise.resolve({}),
    })
    expect(response.status).toBe(401)
  })

  it('marks nothing and reads no bank rows for a company that never migrated', async () => {
    setTable('sie_imports', { data: null })

    const response = await GET(createMockRequest('/api/transactions/migration-coverage'), {
      params: Promise.resolve({}),
    })
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ coverage_end: null, explained_ids: [] })
    expect(tables()).not.toContain('transactions')
  })

  it('crm#1239: marks only the row the ledger explains, never a row the old system did not book', async () => {
    seedMigratedCompany([
      // Paid two supplier invoices in one bank row: E19 + E20 on the same day.
      openRow('tx-batch', '2026-09-30', -7874),
      // Inside the old system's period, but nothing in the ledger books it.
      openRow('tx-unbooked', '2026-09-18', -27500),
      // Same amount as A95, but A95 is 18 days away and already linked.
      openRow('tx-fee', '2026-10-06', -1.85),
    ])

    const response = await GET(createMockRequest('/api/transactions/migration-coverage'), {
      params: Promise.resolve({}),
    })
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ coverage_end: COVERAGE_END, explained_ids: ['tx-batch'] })
    // A 1930 row is searched across the whole bank range, not on 1930 alone.
    expect(findCall('rpc:get_unexplained_bank_legs', 'rpc')?.[0]).toMatchObject({ p_account_number: null })
  })

  it('marks nothing when the ledger scan fails: the marker is advisory and fails open', async () => {
    seedMigratedCompany([openRow('tx-batch', '2026-09-30', -7874)])
    setTable('rpc:get_unexplained_bank_legs', { data: null, error: { message: 'statement timeout' } })

    const response = await GET(createMockRequest('/api/transactions/migration-coverage'), {
      params: Promise.resolve({}),
    })
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data.explained_ids).toEqual([])
  })

  it('returns no ids without open rows in the period', async () => {
    seedMigratedCompany([])

    const response = await GET(createMockRequest('/api/transactions/migration-coverage'), {
      params: Promise.resolve({}),
    })
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ coverage_end: COVERAGE_END, explained_ids: [] })
    expect(tables()).not.toContain('rpc:get_unexplained_bank_legs')
  })
})
