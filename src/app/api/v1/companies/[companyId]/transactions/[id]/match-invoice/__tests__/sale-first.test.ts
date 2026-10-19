/**
 * The public bank match of an invoice a deferring company has not booked yet
 * (defer_invoice_booking): the sale is booked first through the :book step
 * (lib/invoices/sale-first.ts), then the storno of a conflicting
 * categorisation and the payment verifikat. A refusal there refuses the match
 * with the :book code and nothing is written. The rule itself has its own
 * suite; here it is a controllable mock and the tests pin the route's wiring.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const mockPlanSale = vi.fn()
const mockBookSale = vi.fn()
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: (...args: unknown[]) => mockPlanSale(...args),
  bookSaleBeforeSettlement: (...args: unknown[]) => mockBookSale(...args),
}))

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-payment' }),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  reverseEntry: vi.fn().mockResolvedValue({ id: 'je-storno' }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createJournalEntry as mockedCreateJournalEntry,
  reverseEntry as mockedReverseEntry,
} from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events/bus'
import { POST as matchInvoice } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateJournalEntry = mockedCreateJournalEntry as ReturnType<typeof vi.fn>
const mockReverseEntry = mockedReverseEntry as ReturnType<typeof vi.fn>

type RecordedCall = { table: string; method: string; args: unknown[] }

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

const TRANSACTION = {
  id: TX_ID,
  company_id: COMPANY_ID,
  amount: 12500,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  date: '2024-06-15',
  invoice_id: null,
  journal_entry_id: null,
  cash_account_id: null,
  category: null,
}
/** An unbooked faktura of a deferring company, sent and open. */
const SENT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2024-0001',
  invoice_date: '2024-06-01',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  exchange_rate: null,
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  credited_invoice_id: null,
  journal_entry_id: null,
  customer: { name: 'Acme AB' },
}

const SALE_ENTRY = {
  entry_date: '2024-06-01',
  description: 'Kundfaktura 2024-0001',
  lines: [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500, line_description: null },
  ],
  total_debit: 12500,
  total_credit: 12500,
  balanced: true,
  note: 'preview',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY }
const NOT_REQUIRED = { ok: true, required: false }
const BOOKED = { ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [] }
const NOTHING_BOOKED = { ok: true, journalEntryId: null, bookedHere: false, warnings: [] }

function makeRequest(body: unknown): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-1010-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

function db(opts: { tx?: Record<string, unknown>; invoice?: Record<string, unknown>; method?: string } = {}) {
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: { data: { ...TRANSACTION, ...opts.tx }, error: null },
    invoices: [
      { data: { ...SENT_INVOICE, ...opts.invoice }, error: null },
      { data: [{ id: INVOICE_ID }], error: null },
    ],
    company_settings: {
      data: { accounting_method: opts.method ?? 'accrual', entity_type: 'enskild_firma' },
      error: null,
    },
    // The hard-duplicate guard first, then the writer's inserted row.
    invoice_payments: [
      { data: [], error: null },
      { data: { id: 'ip-1' }, error: null },
    ],
  })
}

async function match(supabase: unknown, body: Record<string, unknown> = {}) {
  mockServiceClient.mockReturnValue(supabase)
  const response = await matchInvoice(makeRequest({ invoice_id: INVOICE_ID, ...body }), {
    params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }),
  })
  return { status: response.status, body: await response.json() }
}

/** Writes other than the v1 wrapper's own idempotency reservation. */
function businessWrites(calls: RecordedCall[]) {
  return calls.filter((c) => c.table !== 'idempotency_keys' && (c.method === 'update' || c.method === 'insert'))
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  })
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  mockReverseEntry.mockResolvedValue({ id: 'je-storno' })
  mockPlanSale.mockResolvedValue(NOT_REQUIRED)
  mockBookSale.mockResolvedValue(NOTHING_BOOKED)
})

describe('POST /api/v1/companies/:companyId/transactions/:id/match-invoice: the sale first (defer_invoice_booking)', () => {
  it('books the sale first, then clears 1510, and names the sale in the response', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    const { supabase, calls } = db()

    const { status, body } = await match(supabase)

    expect(status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.journal_entry_id).toBe('je-payment')
    expect(body.data.sale_journal_entry_id).toBe('je-sale')
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, userId: USER_ID }),
      expect.objectContaining({ id: INVOICE_ID, journal_entry_id: null }),
      { settlementDate: '2024-06-15' },
    )
    expect(mockBookSale).toHaveBeenCalledWith(expect.anything(), REQUIRED_PLAN)
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('invoice_paid')
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(12500)
    // The invoice PDF is looked up on the sale verifikat booked first.
    const pdfLookup = calls.filter((c) => c.table === 'document_attachments' && c.method === 'eq')
    expect(pdfLookup.map((c) => c.args)).toContainEqual(['journal_entry_id', 'je-sale'])
  })

  it('books the sale before the storno of a conflicting categorisation, then the payment', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    const { supabase } = db({ tx: { journal_entry_id: 'je-categorised' } })

    const { status } = await match(supabase)

    expect(status).toBe(200)
    expect(mockReverseEntry).toHaveBeenCalled()
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockReverseEntry.mock.invocationCallOrder[0])
    expect(mockReverseEntry.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
  })

  it('a partial payment books the whole sale, then the partial clearing', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    const { supabase } = db({ tx: { amount: 5000 } })

    const { status, body } = await match(supabase)

    expect(status).toBe(200)
    expect(body.data.invoice_status).toBe('partially_paid')
    expect(body.data.sale_journal_entry_id).toBe('je-sale')
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; credit_amount: number }>
    }
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(5000)
  })

  it('refuses with the :book code and writes nothing when the plan refuses', async () => {
    mockPlanSale.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: '2024-06-01', sale_first: true, invoice_id: INVOICE_ID },
    })
    const { supabase, calls } = db({ tx: { journal_entry_id: 'je-categorised' } })

    const { status, body } = await match(supabase)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_NO_FISCAL_PERIOD')
    expect(body.error.details).toMatchObject({ sale_first: true })
    expect(mockBookSale).not.toHaveBeenCalled()
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('refuses with the :book code and writes nothing when booking the sale is refused', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'period_locked_at_set', invoice_date: '2024-06-01', sale_first: true, invoice_id: INVOICE_ID },
    })
    const { supabase, calls } = db({ tx: { journal_entry_id: 'je-categorised' } })

    const { status, body } = await match(supabase)

    expect(status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ sale_first: true, invoice_date: '2024-06-01' })
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(businessWrites(calls)).toEqual([])
  })

  it('names the sale when the payment verifikat then books nothing', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    mockCreateJournalEntry.mockResolvedValueOnce(null)
    const { supabase, calls } = db()

    const { status, body } = await match(supabase)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
    expect(body.error.details).toMatchObject({ reason: 'no_journal_entry_created', sale_journal_entry_id: 'je-sale' })
    expect(businessWrites(calls)).toEqual([])
  })

  it('an already booked invoice (plan: not required) pays as before, with no sale named', async () => {
    const { supabase } = db({ invoice: { journal_entry_id: 'je-issue' } })

    const { status, body } = await match(supabase)

    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-payment')
    expect(body.data).not.toHaveProperty('sale_journal_entry_id')
    expect(mockPlanSale).toHaveBeenCalledTimes(1)
  })

  it('kontantmetoden (plan: not required) books as before, with no sale named', async () => {
    const { supabase } = db({ method: 'cash' })

    const { status, body } = await match(supabase)

    expect(status).toBe(200)
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data).not.toHaveProperty('sale_journal_entry_id')
  })

  it('custom lines that book the revenue themselves (no 151x credit) skip the plan', async () => {
    const { supabase } = db()

    const { status, body } = await match(supabase, {
      lines: [
        { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      ],
    })

    expect(status).toBe(200)
    expect(mockPlanSale).not.toHaveBeenCalled()
    expect(body.data).not.toHaveProperty('sale_journal_entry_id')
  })

  it('custom lines that clear 1510 still book the sale first', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    const { supabase } = db()

    const { status, body } = await match(supabase, {
      lines: [
        { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 12500 },
      ],
    })

    expect(status).toBe(200)
    expect(mockPlanSale).toHaveBeenCalledTimes(1)
    expect(body.data.sale_journal_entry_id).toBe('je-sale')
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
  })
})
