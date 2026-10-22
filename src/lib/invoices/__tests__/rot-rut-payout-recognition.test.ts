import { roundOre } from '@/lib/money'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-2026'),
  getSwedishLocalDate: vi.fn().mockReturnValue('2026-10-22'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'je-payout',
      ...input,
    }),
  ),
}))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { getPayoutRecognition, isDeductionShareUnbooked } = await import('../rot-rut-payout-recognition')
const { createRotRutPayoutEntry } = await import('@/lib/bookkeeping/rot-rut-entries')
const { buildInvoiceCashLines, buildInvoiceRegistrationLines } = await import('@/lib/bookkeeping/invoice-lines')

/**
 * Kontantmetoden's second step at the payout (ML 2023:200 7 kap. 16 §;
 * Skatteverket, "Så fungerar rotavdraget"): an invoice whose customer payment
 * booked only the customer's share gets its deduction share booked as
 * försäljning and moms when Skatteverket pays, for what it paid.
 */

const REQUEST = { id: 'req-1', requested_total: 3750 }

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Arbete',
    quantity: 1,
    unit: 'st',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    deduction_type: 'rot',
    deduction_amount: 3750,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: '1042',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    delivery_country: null,
    default_dimensions: null,
    journal_entry_id: null,
    subtotal: 10000,
    vat_amount: 2500,
    total: 12500,
    items: [item()],
    ...overrides,
  }
}

function setup(opts: {
  method?: 'cash' | 'accrual'
  invoices?: Array<Record<string, unknown>>
  items?: Array<Record<string, unknown>>
  payments?: Array<Record<string, unknown>>
  entries?: Array<Record<string, unknown>>
  lines1513?: Array<Record<string, unknown>>
  periodStart?: string
}) {
  const mock = createTableMockSupabase({
    company_settings: { data: { accounting_method: opts.method ?? 'cash', entity_type: 'aktiebolag' } },
    rot_rut_payout_request_items: {
      data: opts.items ?? [{ invoice_id: 'inv-1', requested_amount: 3750, decided_amount: null }],
    },
    invoices: { data: opts.invoices ?? [invoiceRow()] },
    invoice_payments: { data: opts.payments ?? [{ invoice_id: 'inv-1', journal_entry_id: 'je-cash' }] },
    fiscal_periods: { data: [{ period_start: opts.periodStart ?? '2026-01-01' }] },
    journal_entries: {
      data: opts.entries ?? [
        { id: 'je-cash', status: 'posted', reversed_by_id: null, source_type: 'invoice_cash_payment', entry_date: '2026-09-20' },
      ],
    },
    journal_entry_lines: { data: opts.lines1513 ?? [] },
  })
  return mock
}

function net(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    out[line.account_number] = roundOre((out[line.account_number] ?? 0) + line.credit_amount - line.debit_amount)
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPayoutRecognition', () => {
  it('faktureringsmetoden: nothing to recognise, nothing else read', async () => {
    const mock = setup({ method: 'accrual' })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    expect(result).toEqual({ ok: true, recognition: null })
    expect(mock.tables()).toEqual(['company_settings'])
  })

  it('a kontantmetod invoice paid without 1513: the payout books 3 000 revenue and 750 moms', async () => {
    const mock = setup({})
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    expect(result.ok).toBe(true)
    const recognition = (result as { recognition: { amount: number; lines: CreateJournalEntryLineInput[] } }).recognition
    expect(recognition.amount).toBe(3750)
    expect(net(recognition.lines)).toEqual({ '3001': 3000, '2611': 750 })
  })

  it('a payment voucher that already debited 1513 (booked before the two steps) keeps the 1513 path', async () => {
    const mock = setup({ lines1513: [{ journal_entry_id: 'je-cash' }] })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    expect(result).toEqual({ ok: true, recognition: null })
  })

  it('an invoice linked to its own verifikat (year-end carry, registration) keeps the 1513 path', async () => {
    const mock = setup({ invoices: [invoiceRow({ journal_entry_id: 'je-carry' })] })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    expect(result).toEqual({ ok: true, recognition: null })
  })

  it('a customer payment in an earlier räkenskapsår keeps the 1513 path: that year end carried the share', async () => {
    const mock = setup({ periodStart: '2027-01-01' })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2027-01-12')
    expect(result).toEqual({ ok: true, recognition: null })
  })

  it('no live kontantmetod payment voucher: no evidence, the 1513 path', async () => {
    const mock = setup({
      entries: [{ id: 'je-cash', status: 'posted', reversed_by_id: 'je-storno', source_type: 'invoice_cash_payment', entry_date: '2026-09-20' }],
    })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    expect(result).toEqual({ ok: true, recognition: null })
  })

  it('a partly approved claim books revenue and moms on what Skatteverket paid only', async () => {
    const mock = setup({ items: [{ invoice_id: 'inv-1', requested_amount: 3750, decided_amount: 3000 }] })
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3000, '2026-10-10')
    const recognition = (result as { recognition: { amount: number; lines: CreateJournalEntryLineInput[] } }).recognition
    expect(recognition.amount).toBe(3000)
    expect(net(recognition.lines)).toEqual({ '3001': 2400, '2611': 600 })
  })

  it('several invoices: the beslut\'s per-invoice amounts, or a refusal when only a total is known', async () => {
    const invoices = [
      invoiceRow(),
      invoiceRow({ id: 'inv-2', invoice_number: '1043', items: [item({ id: 'item-2', invoice_id: 'inv-2', deduction_amount: 3750 })] }),
    ]
    const payments = [
      { invoice_id: 'inv-1', journal_entry_id: 'je-cash' },
      { invoice_id: 'inv-2', journal_entry_id: 'je-cash-2' },
    ]
    const entries = [
      { id: 'je-cash', status: 'posted', reversed_by_id: null, source_type: 'invoice_cash_payment', entry_date: '2026-09-20' },
      { id: 'je-cash-2', status: 'posted', reversed_by_id: null, source_type: 'invoice_cash_payment', entry_date: '2026-09-21' },
    ]
    const request = { id: 'req-1', requested_total: 7500 }

    const decided = setup({
      invoices,
      payments,
      entries,
      items: [
        { invoice_id: 'inv-1', requested_amount: 3750, decided_amount: 3750 },
        { invoice_id: 'inv-2', requested_amount: 3750, decided_amount: 1250 },
      ],
    })
    const split = await getPayoutRecognition(decided.supabase as unknown as SupabaseClient, 'company-1', request, 5000, '2026-10-10')
    const recognition = (split as { recognition: { amount: number; invoices: unknown[]; lines: CreateJournalEntryLineInput[] } }).recognition
    expect(recognition.invoices).toEqual([{ invoiceId: 'inv-1', paid: 3750 }, { invoiceId: 'inv-2', paid: 1250 }])
    expect(net(recognition.lines)).toEqual({ '3001': 4000, '2611': 1000 })

    const totalOnly = setup({
      invoices,
      payments,
      entries,
      items: [
        { invoice_id: 'inv-1', requested_amount: 3750, decided_amount: null },
        { invoice_id: 'inv-2', requested_amount: 3750, decided_amount: null },
      ],
    })
    const refused = await getPayoutRecognition(totalOnly.supabase as unknown as SupabaseClient, 'company-1', request, 5000, '2026-10-10')
    expect(refused).toMatchObject({ ok: false, code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN' })
  })
})

describe('kontantmetoden end to end: customer payment, then payout', () => {
  it('together book exactly what faktureringsmetoden books, per account', async () => {
    const invoice = { ...invoiceRow(), deduction_total: 3750 } as unknown as Invoice

    // Faktureringsmetoden: registration, customer payment (1930 / 1510), payout (1930 / 1513).
    const accrual = net([
      ...buildInvoiceRegistrationLines(invoice, 'aktiebolag'),
      { account_number: '1930', debit_amount: 8750, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 8750 },
      { account_number: '1930', debit_amount: 3750, credit_amount: 0 },
      { account_number: '1513', debit_amount: 0, credit_amount: 3750 },
    ] as CreateJournalEntryLineInput[])

    // Kontantmetoden: the payment's first step, then the payout's second.
    const payment = buildInvoiceCashLines(invoice, 'aktiebolag', undefined, '1930', undefined, undefined, {
      deferDeductionShare: true,
    }).lines
    const mock = setup({})
    const result = await getPayoutRecognition(mock.supabase as unknown as SupabaseClient, 'company-1', REQUEST, 3750, '2026-10-10')
    await createRotRutPayoutEntry(null as never, 'company-1', 'user-1', {
      requestId: 'req-1',
      requestName: 'ROT 2026-10',
      deductionType: 'rot',
      paymentDate: '2026-10-10',
      amount: 3750,
      recognition: (result as { recognition: { amount: number; lines: CreateJournalEntryLineInput[] } }).recognition,
    })
    const payout = vi.mocked(createJournalEntry).mock.calls[0][3] as CreateJournalEntryInput
    expect(payout.lines.some((line) => line.account_number === '1513')).toBe(false)
    const cash = net([...payment, ...payout.lines])

    const nonZero = (rows: Record<string, number>) => Object.fromEntries(Object.entries(rows).filter(([, v]) => v !== 0))
    expect(nonZero(cash)).toEqual(nonZero(accrual))
    expect(nonZero(cash)).toEqual({ '1930': -12500, '3001': 10000, '2611': 2500 })
  })
})

describe('isDeductionShareUnbooked (the kreditfaktura question)', () => {
  const ask = (mock: ReturnType<typeof setup>, journalEntryId: string | null = null) =>
    isDeductionShareUnbooked(mock.supabase as unknown as SupabaseClient, 'company-1', { id: 'inv-1', journal_entry_id: journalEntryId })

  it('unbooked: paid under the two steps and no payout booked', async () => {
    expect(await ask(setup({ items: [] }))).toEqual({ ok: true, unbooked: true })
    const pending = setup({ items: [{ invoice_id: 'inv-1', request: { status: 'submitted', settlement_journal_entry_id: null } }] })
    expect(await ask(pending)).toEqual({ ok: true, unbooked: true })
  })

  it('booked: a payout settled it, the payment carried 1513, or the invoice has its own verifikat', async () => {
    const settled = setup({ items: [{ invoice_id: 'inv-1', request: { status: 'paid', settlement_journal_entry_id: 'je-payout' } }] })
    expect(await ask(settled)).toEqual({ ok: true, unbooked: false })
    expect(await ask(setup({ lines1513: [{ journal_entry_id: 'je-cash' }] }))).toEqual({ ok: true, unbooked: false })
    expect(await ask(setup({}), 'je-carry')).toEqual({ ok: true, unbooked: false })
  })
})
