/**
 * One categorization, five doors, one verifikat.
 *
 * The dashboard route, the v1 :categorize and batch-categorize routes, the
 * approval executor and the MCP tool's staging preview used to be five
 * copies of the booking logic, and they drifted: batch-categorize ignored
 * account_override and vat_amount and skipped the counter-leg guard, v1
 * ignored vat_amount, and the MCP preview computed its own lines. They now
 * all call categorizeTransaction (lib/transactions/categorize-core.ts).
 *
 * The same row and the same choice (an account override, the underlag's own
 * moms) go through every door here; each booking door must hand the engine
 * the identical kontering, and the MCP preview must show the lines that
 * kontering posts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The dashboard door's question about a filed momsperiod
// (lib/transactions/filed-vat-categorize.ts) reads the row and the filing
// record: none here, so every door's stubbed reads stay the booking's own.
vi.mock('@/lib/transactions/filed-vat-categorize', () => ({
  filedPeriodCategorizeWarning: async () => null,
}))
import { createTableMockSupabase } from '@/tests/helpers'
import type { MappingResult, Transaction } from '@/types'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const { createTxJE, doors } = vi.hoisted(() => ({
  createTxJE: vi.fn(),
  doors: { dashboard: null as unknown },
}))

vi.mock('@/lib/bookkeeping/transaction-entries', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/transaction-entries')>()),
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/suggestion-log/record', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_s: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/transactions/inbox-underlag', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/inbox-underlag')>()),
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
}))

// The dashboard door's session plumbing.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(doors.dashboard),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  getActiveCompanyId: vi.fn().mockResolvedValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// The v1 doors' API-key plumbing.
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'
import { POST as dashboardPOST } from '@/app/api/transactions/[id]/categorize/route'
import { POST as v1POST } from '@/app/api/v1/companies/[companyId]/transactions/[id]/categorize/route'
import { POST as batchPOST } from '@/app/api/v1/companies/[companyId]/transactions/batch-categorize/route'
import { tools } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

const txRow = {
  id: TX_ID,
  company_id: COMPANY_ID,
  date: '2026-05-12',
  amount: -1250,
  currency: 'SEK',
  amount_sek: -1250,
  exchange_rate: 1,
  description: 'KONTORSBOLAGET',
  merchant_name: 'Kontorsbolaget',
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  is_business: null,
  is_ignored: false,
}

/** The choice every door makes: an override account and the underlag's moms. */
const choice = {
  category: 'expense_office',
  vat_treatment: 'standard_25',
  vat_amount: 200,
  account_override: '5410',
} as const

function ledger() {
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: [
      { data: txRow, error: null },
      // The compare-and-set write matches the row.
      { data: [{ ...txRow, journal_entry_id: 'je-1', is_business: true }], error: null },
    ],
    company_settings: { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1, vat_registered: true }, error: null },
    cash_accounts: { data: [], error: null },
    chart_of_accounts: { data: { account_number: '5410', account_class: 5, is_active: true }, error: null },
    fiscal_periods: { data: [{ id: 'fp-1' }], error: null },
    // The staging insert answers the row; the open-claims read (crm#1264) finds none.
    pending_operations: (chainCalls) =>
      chainCalls.some((c) => c.method === 'insert') ? { data: { id: 'op-1' }, error: null } : { data: [], error: null },
  })
}

function v1Request(path: string, body: unknown): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

/** The kontering the engine was handed on the last booking. */
function postedMapping(): MappingResult {
  expect(createTxJE).toHaveBeenCalledTimes(1)
  return createTxJE.mock.calls[0][4] as MappingResult
}

beforeEach(() => {
  vi.clearAllMocks()
  createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  } as never)
})

async function bookThroughDashboard(): Promise<MappingResult> {
  const { supabase } = ledger()
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'a@b.se' } }, error: null })
  doors.dashboard = supabase
  const res = await dashboardPOST(
    new Request(`https://x.test/api/transactions/${TX_ID}/categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_business: true, ...choice }),
    }) as never,
    { params: Promise.resolve({ id: TX_ID }) },
  )
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return postedMapping()
}

async function bookThroughV1(): Promise<MappingResult> {
  vi.mocked(createServiceClientNoCookies).mockReturnValue(ledger().supabase as never)
  const res = await v1POST(v1Request(`transactions/${TX_ID}/categorize`, { is_business: true, ...choice }), {
    params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }),
  })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return postedMapping()
}

async function bookThroughBatch(): Promise<MappingResult> {
  vi.mocked(createServiceClientNoCookies).mockReturnValue(ledger().supabase as never)
  const res = await batchPOST(
    v1Request('transactions/batch-categorize', {
      items: [{ transaction_id: TX_ID, categorization: { is_business: true, ...choice } }],
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )
  const body = await res.json()
  expect(body.data.summary, JSON.stringify(body)).toEqual({ total: 1, succeeded: 1, failed: 0 })
  return postedMapping()
}

async function bookThroughApproval(): Promise<MappingResult> {
  const result = await categorizeMatchedTransaction(ledger().supabase as never, USER_ID, COMPANY_ID, TX_ID, {
    category: choice.category,
    vatTreatment: choice.vat_treatment,
    vatAmount: choice.vat_amount,
    accountOverride: choice.account_override,
  })
  expect(result.error).toBeUndefined()
  return postedMapping()
}

describe('categorize: every door books the same verifikat', () => {
  it('posts one kontering from the dashboard, v1, batch-categorize and the approval executor', async () => {
    const dashboard = await bookThroughDashboard()
    vi.clearAllMocks()
    createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
    const v1 = await bookThroughV1()
    vi.clearAllMocks()
    createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
    const batch = await bookThroughBatch()
    vi.clearAllMocks()
    createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
    const approval = await bookThroughApproval()

    // The override account carries the business side, and the underlag's own
    // moms (200, not 25 % of the net) is the VAT line: the two fields
    // batch-categorize used to drop and v1 used to ignore.
    expect(approval.debit_account).toBe('5410')
    expect(approval.credit_account).toBe('1930')
    expect(approval.vat_lines).toEqual([
      expect.objectContaining({ account_number: '2641', debit_amount: 200 }),
    ])
    expect(dashboard).toEqual(approval)
    expect(v1).toEqual(approval)
    expect(batch).toEqual(approval)
  })

  it('previews over MCP exactly the lines the approval posts', async () => {
    const approval = await bookThroughApproval()
    const posted = buildTransactionEntryLines(txRow as unknown as Transaction, approval)

    const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!
    const staged = (await categorize.execute(
      { transaction_id: TX_ID, ...choice },
      COMPANY_ID,
      USER_ID,
      ledger().supabase as never,
      { type: 'api_key' } as never,
    )) as { staged: boolean; preview: { lines: Array<Record<string, unknown>>; debit_account: string } }

    expect(staged.staged).toBe(true)
    expect(staged.preview.debit_account).toBe('5410')
    expect(staged.preview.lines).toEqual(
      posted.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.line_description ?? '',
      })),
    )
  })
})
