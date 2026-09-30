/**
 * Door parity (#3253): the same bank row matched to the same supplier invoice
 * books the same verifikat and the same ledger update through the dashboard
 * POST and the public v1 POST. The v1 door used to derive its own payment
 * plan: it cleared the whole bank row off 2440 with no 6570 fee line, no 3740
 * öre line and no overshoot guard, so paid_amount could pass the invoice total.
 *
 * Both routes run for real down to the engine: the entry builders are not
 * mocked, only createJournalEntry / findFiscalPeriod (captured) and the
 * side-effect helpers that are pinned elsewhere.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput } from '@/types'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const { supabase, setTable, reset, findCall } = createTableMockSupabase()

// Dashboard door: cookie session.
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

// v1 door: API key.
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(() => supabase),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-1'),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn(),
}))

import { validateApiKey } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import { POST as dashboardPOST } from '../route'
import { POST as v1POST } from '@/app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SI_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface Fixture {
  transaction: { amount: number; currency?: string; amount_sek?: number | null }
  invoice: Record<string, unknown>
  accountingMethod?: 'accrual' | 'cash'
}

const ITEMS = [
  {
    id: 'item-1', description: 'Kontorsmaterial', quantity: 1, unit: 'st', unit_price: 800,
    line_total: 800, account_number: '6110', vat_code: null, vat_rate: 0.25, vat_amount: 200,
    reverse_charge_rate: null,
  },
]

function seed(f: Fixture) {
  reset()
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'u@example.test' } }, error: null })
  setTable('company_members', { data: { company_id: COMPANY_ID, role: 'owner' } })
  setTable('transactions', {
    data: {
      id: TX_ID, company_id: COMPANY_ID, date: '2026-09-15', currency: 'SEK', amount_sek: null,
      supplier_invoice_id: null, journal_entry_id: null, cash_account_id: null, document_id: null,
      ...f.transaction,
    },
  })
  setTable('supplier_invoices', [
    {
      data: {
        id: SI_ID, supplier_invoice_number: 'LF-100', arrival_number: 7, status: 'registered',
        currency: 'SEK', exchange_rate: null, total: 1000, paid_amount: 0, remaining_amount: 1000,
        registration_journal_entry_id: 'je-registration', reverse_charge: false,
        vat_treatment: 'standard_25', default_dimensions: { '6': 'P1' },
        supplier: { name: 'Leverantor AB', supplier_type: 'swedish_business' },
        items: ITEMS,
        ...f.invoice,
      },
    },
    { data: [{ id: SI_ID }] },
  ])
  setTable('company_settings', { data: { accounting_method: f.accountingMethod ?? 'accrual' } })
}

interface DoorResult {
  status: number
  code?: string
  entry?: Pick<CreateJournalEntryInput, 'description' | 'source_type' | 'lines'>
  invoiceUpdate?: Record<string, unknown>
  paymentAmount?: unknown
  result?: Record<string, unknown>
}

function capture(status: number, body: Record<string, unknown>, result?: Record<string, unknown>): DoorResult {
  const input = mockCreateJournalEntry.mock.calls[0]?.[3] as CreateJournalEntryInput | undefined
  const update = findCall('supplier_invoices', 'update')?.[0] as Record<string, unknown> | undefined
  const insert = findCall('supplier_invoice_payments', 'insert')?.[0] as Record<string, unknown> | undefined
  return {
    status,
    code: (body.error as { code?: string } | undefined)?.code,
    entry: input && { description: input.description, source_type: input.source_type, lines: input.lines },
    invoiceUpdate: update && {
      status: update.status,
      paid_amount: update.paid_amount,
      remaining_amount: update.remaining_amount,
      paid_at: update.paid_at,
    },
    paymentAmount: insert?.amount,
    result,
  }
}

async function viaDashboard(f: Fixture): Promise<DoorResult> {
  seed(f)
  mockCreateJournalEntry.mockClear()
  const res = await dashboardPOST(
    new Request(`http://localhost/api/transactions/${TX_ID}/match-supplier-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier_invoice_id: SI_ID }),
    }),
    { params: Promise.resolve({ id: TX_ID }) },
  )
  const body = (await res.json()) as Record<string, unknown>
  const result = res.ok
    ? { invoice_status: body.invoice_status, paid_amount: body.paid_amount, remaining_amount: body.remaining_amount }
    : undefined
  return capture(res.status, body, result)
}

async function viaV1(f: Fixture): Promise<DoorResult> {
  seed(f)
  mockCreateJournalEntry.mockClear()
  const res = await v1POST(
    new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-fixture-not-a-real-key',
          'Content-Type': 'application/json',
          'Idempotency-Key': `idem-${Math.random().toString(16).slice(2)}-4abc-8def-1234567890ab`,
        },
        body: JSON.stringify({ supplier_invoice_id: SI_ID }),
      },
    ),
    { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
  )
  const body = (await res.json()) as Record<string, unknown>
  const data = body.data as Record<string, unknown> | undefined
  const result = res.ok && data
    ? { invoice_status: data.invoice_status, paid_amount: data.paid_amount, remaining_amount: data.remaining_amount }
    : undefined
  return capture(res.status, body, result)
}

type Line = { account_number: string; debit_amount: number; credit_amount: number }
const shape = (lines: Line[] | undefined) =>
  (lines ?? []).map((l) => [l.account_number, l.debit_amount, l.credit_amount])

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:write'],
    mode: 'live',
  } as never)
})

const CASES: Array<{
  name: string
  fixture: Fixture
  lines: Array<[string, number, number]>
  ledger: { status: string; paid_amount: number; remaining_amount: number }
  paymentAmount: number
}> = [
  {
    name: 'an exact SEK payment',
    fixture: { transaction: { amount: -1000 }, invoice: {} },
    lines: [['2440', 1000, 0], ['1930', 0, 1000]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 1000,
  },
  {
    name: 'a SEK payment with a bank fee on top (6570)',
    fixture: { transaction: { amount: -1010 }, invoice: {} },
    lines: [['2440', 1000, 0], ['1930', 0, 1010], ['6570', 10, 0]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 1000,
  },
  // The öre band is open at one krona, so exactly 1.00 over is a fee. A gap
  // there used to book no fee, no 3740 and no refusal: 1930 credited a krona
  // less than the bank row and paid_amount past the invoice total.
  {
    name: 'a SEK payment exactly one krona over (6570, not a gap)',
    fixture: { transaction: { amount: -1001 }, invoice: {} },
    lines: [['2440', 1000, 0], ['1930', 0, 1001], ['6570', 1, 0]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 1000,
  },
  {
    name: 'completing a part-paid invoice exactly one krona over',
    fixture: { transaction: { amount: -501 }, invoice: { paid_amount: 500, remaining_amount: 500 } },
    lines: [['2440', 500, 0], ['1930', 0, 501], ['6570', 1, 0]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 500,
  },
  {
    name: 'a whole-krona payment of an öre total (3740 vinst)',
    fixture: { transaction: { amount: -1234 }, invoice: { total: 1234.44, remaining_amount: 1234.44 } },
    lines: [['2440', 1234.44, 0], ['1930', 0, 1234], ['3740', 0, 0.44]],
    ledger: { status: 'paid', paid_amount: 1234.44, remaining_amount: 0 },
    paymentAmount: 1234.44,
  },
  {
    name: 'a rounded-up whole-krona payment (3740 förlust)',
    fixture: { transaction: { amount: -1235 }, invoice: { total: 1234.44, remaining_amount: 1234.44 } },
    lines: [['2440', 1234.44, 0], ['1930', 0, 1235], ['3740', 0.56, 0]],
    ledger: { status: 'paid', paid_amount: 1234.44, remaining_amount: 0 },
    paymentAmount: 1234.44,
  },
  {
    name: 'a partial payment a krona or more short',
    fixture: { transaction: { amount: -500 }, invoice: {} },
    lines: [['2440', 500, 0], ['1930', 0, 500]],
    ledger: { status: 'partially_paid', paid_amount: 500, remaining_amount: 500 },
    paymentAmount: 500,
  },
  {
    name: 'a SEK row paying a EUR invoice (kursvinst)',
    fixture: {
      transaction: { amount: -1050 },
      invoice: { currency: 'EUR', exchange_rate: 11, total: 100, remaining_amount: 100 },
    },
    lines: [['2440', 1100, 0], ['1930', 0, 1050], ['3960', 0, 50]],
    ledger: { status: 'paid', paid_amount: 100, remaining_amount: 0 },
    paymentAmount: 100,
  },
  {
    name: 'a kontantmetoden payment with a bank fee on top',
    fixture: {
      transaction: { amount: -1010 },
      invoice: { registration_journal_entry_id: null },
      accountingMethod: 'cash',
    },
    lines: [['6110', 800, 0], ['2641', 200, 0], ['1930', 0, 1010], ['6570', 10, 0]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 1000,
  },
  {
    name: 'a kontantmetoden payment exactly one krona over',
    fixture: {
      transaction: { amount: -1001 },
      invoice: { registration_journal_entry_id: null },
      accountingMethod: 'cash',
    },
    lines: [['6110', 800, 0], ['2641', 200, 0], ['1930', 0, 1001], ['6570', 1, 0]],
    ledger: { status: 'paid', paid_amount: 1000, remaining_amount: 0 },
    paymentAmount: 1000,
  },
]

describe('supplier bank match: the dashboard and v1 doors book the same payment the same way', () => {
  it.each(CASES)('$name', async ({ fixture, lines, ledger, paymentAmount }) => {
    const dashboard = await viaDashboard(fixture)
    const v1 = await viaV1(fixture)

    expect(dashboard.status).toBe(200)
    expect(v1.status).toBe(200)
    // The expected books, so the two doors cannot agree on a wrong answer.
    expect(shape(dashboard.entry?.lines)).toEqual(lines)
    // The payment account moves exactly what the bank row moved.
    const bankCredit = (dashboard.entry?.lines ?? [])
      .filter((l) => l.account_number === '1930')
      .reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
    expect(roundOre(bankCredit)).toBe(Math.abs(fixture.transaction.amount))
    expect(dashboard.invoiceUpdate).toMatchObject(ledger)
    expect(dashboard.paymentAmount).toBe(paymentAmount)
    expect(dashboard.result).toEqual({
      invoice_status: ledger.status,
      paid_amount: ledger.paid_amount,
      remaining_amount: ledger.remaining_amount,
    })

    // And the v1 door books exactly the same: lines (texts and dimension bags
    // included), header, source type, ledger update, payment row, response.
    expect(v1.entry).toEqual(dashboard.entry)
    expect(v1.invoiceUpdate).toEqual(dashboard.invoiceUpdate)
    expect(v1.paymentAmount).toBe(dashboard.paymentAmount)
    expect(v1.result).toEqual(dashboard.result)
  })

  it('both refuse an overshoot past the fee cap with the same code, booking nothing', async () => {
    const fixture: Fixture = {
      transaction: { amount: -50000 },
      invoice: { total: 5000, remaining_amount: 5000 },
    }
    const dashboard = await viaDashboard(fixture)
    const v1 = await viaV1(fixture)

    expect(dashboard).toMatchObject({ status: 400, code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING' })
    expect(v1).toMatchObject({ status: 400, code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING' })
    for (const door of [dashboard, v1]) {
      expect(door.entry).toBeUndefined()
      expect(door.invoiceUpdate).toBeUndefined()
      expect(door.paymentAmount).toBeUndefined()
    }
  })
})
