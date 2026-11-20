/**
 * customerMatchExpectedLines: the rows the staged preview of a single
 * bank-row-to-invoice match shows (crm#1813) are the rows the approval posts.
 *
 * Every case books the same row and invoice through bookCustomerBankMatch
 * with the engine mocked, and compares the lines it hands the engine with the
 * preview's. A preview that drifts from the booking is worse than none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  cancelOrphanedEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
const mockSettlementAccount = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => '1930'))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({ resolveSettlementAccount: mockSettlementAccount }))
vi.mock('@/lib/bookkeeping/account-validation', () => ({ findUnresolvableAccounts: vi.fn(async () => []) }))
// What the ledger carries for a foreign invoice: null, so both sides value
// the receivable at the invoice's booking rate.
vi.mock('@/lib/bookkeeping/ledger-carried-sek', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/ledger-carried-sek')>()),
  carriedSekOf: vi.fn(async () => null),
}))
const mockRate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/currency/riksbanken')>()),
  fetchExchangeRate: mockRate,
}))
vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/paid-events', () => ({ emitInvoicePaidIfSettled: vi.fn(async () => undefined) }))
vi.mock('@/lib/customer-loss/doubtful', () => ({ releaseDoubtfulReserveAfterChange: vi.fn(async () => undefined) }))
vi.mock('@/lib/company/entity-type', () => ({ resolveCompanyEntityType: vi.fn(async () => 'aktiebolag') }))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn(async () => 'evt-1') }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: vi.fn(async () => undefined) }))

const { cancelOrphanedEntry, createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { bookCustomerBankMatch } = await import('../book-customer-bank-match')
const { planTransactionInvoiceMatch } = await import('../match-payment-plan')
const { customerMatchExpectedLines } = await import('../customer-match-expected-lines')

const COMPANY = 'company-1'
const TX = 'tx-1'
const INVOICE_ID = 'inv-1'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

const ROW = {
  id: TX,
  company_id: COMPANY,
  date: '2026-09-28',
  amount: 1500,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  cash_account_id: null,
  category: 'income_products',
  invoice_id: null,
  potential_invoice_id: null,
  is_business: null,
  is_ignored: false,
  journal_entry_id: null,
  reconciliation_method: null,
}
const INVOICE = {
  id: INVOICE_ID,
  invoice_number: 'F-1',
  document_type: 'invoice',
  status: 'sent',
  currency: 'SEK',
  exchange_rate: null,
  total: 1500,
  subtotal: 1200,
  vat_amount: 300,
  paid_amount: 0,
  remaining_amount: 1500,
  paid_at: null,
  credited_invoice_id: null,
  journal_entry_id: 'je-sent',
  customer: { name: 'Kund AB' },
  items: [],
  credit_notes: [],
}

interface World {
  row?: Record<string, unknown>
  invoice?: Record<string, unknown>
  settings?: { data?: unknown; error?: unknown }
}

function world(w: World) {
  return createTableMockSupabase({
    transactions: [{ data: { ...ROW, ...w.row } }, { data: [{ id: TX }] }, { data: null }],
    invoices: [{ data: { ...INVOICE, ...w.invoice } }, { data: [{ id: INVOICE_ID }] }, { data: null }],
    transaction_voucher_links: { data: [] },
    journal_entries: { data: [] },
    invoice_payments: [{ data: [] }, { data: { id: 'ip-1' } }],
    company_settings: w.settings ?? { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
    document_attachments: { data: null },
  })
}

/** The preview, built as the staging builds it: from its own plan of the pair. */
async function preview(w: World) {
  const row = { ...ROW, ...w.row }
  const invoice = { ...INVOICE, ...w.invoice }
  const { supabase } = world(w)
  const plan = await planTransactionInvoiceMatch(supabase as never, row, invoice as never, {})
  if (!plan.ok) throw new Error(`plan refused: ${plan.code}`)
  return customerMatchExpectedLines(
    { supabase: supabase as never, companyId: COMPANY, log },
    row,
    invoice as never,
    plan,
    { ok: true, required: false },
  )
}

/** The lines the booking hands the engine for the same pair. */
async function booked(w: World) {
  const { supabase } = world(w)
  const outcome = await bookCustomerBankMatch(
    { supabase: supabase as never, companyId: COMPANY, userId: 'user-1', log },
    { transactionId: TX, invoiceId: INVOICE_ID, overrideVia: 'dashboard_force' },
  )
  expect(outcome).toMatchObject({ ok: true })
  const input = vi.mocked(createJournalEntry).mock.calls[0]![3] as {
    lines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[]
  }
  return input.lines.map((line) => ({
    account_number: line.account_number,
    description: line.line_description ?? '',
    debit: line.debit_amount,
    credit: line.credit_amount,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POSTING_EVENTS', '')
  eventBus.clear()
  mockSettlementAccount.mockResolvedValue('1930')
  mockRate.mockResolvedValue({ rate: 10.4 })
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-payment' } as never)
  vi.mocked(cancelOrphanedEntry).mockResolvedValue({ error: null })
})

describe('customerMatchExpectedLines: the preview is what the approval posts', () => {
  it('a kronor invoice paid in full: bank against 1510', async () => {
    const shown = await preview({})
    expect(shown).toEqual({
      expected_lines: [
        expect.objectContaining({ account_number: '1930', debit: 1500, credit: 0 }),
        expect.objectContaining({ account_number: '1510', debit: 0, credit: 1500 }),
      ],
      expected_lines_balanced: true,
    })
    expect(shown!.expected_lines).toEqual(await booked({}))
  })

  it('a foreign invoice paid in kronor below its booked value: the kursförlust is on the preview', async () => {
    // 100 USD booked at 10.46 (1 046 kr on 1510), paid with 1 040 kr at 10.40.
    const w: World = {
      row: { amount: 1040 },
      invoice: { currency: 'USD', exchange_rate: 10.46, total: 100, subtotal: 100, vat_amount: 0, remaining_amount: 100 },
    }
    const shown = await preview(w)
    expect(shown!.expected_lines_balanced).toBe(true)
    expect(shown!.expected_lines).toContainEqual(expect.objectContaining({ account_number: '1930', debit: 1040, credit: 0 }))
    expect(shown!.expected_lines).toContainEqual(expect.objectContaining({ account_number: '1510', debit: 0, credit: 1046 }))
    expect(shown!.expected_lines).toContainEqual(expect.objectContaining({ account_number: '7960', debit: 6, credit: 0 }))
    expect(shown!.expected_lines).toEqual(await booked(w))
  })

  it('a foreign invoice paid above its booked value: the kursvinst is on the preview', async () => {
    const w: World = {
      row: { amount: 1040 },
      invoice: { currency: 'USD', exchange_rate: 10.31, total: 100, subtotal: 100, vat_amount: 0, remaining_amount: 100 },
    }
    const shown = await preview(w)
    expect(shown!.expected_lines).toContainEqual(expect.objectContaining({ account_number: '3960', debit: 0, credit: 9 }))
    expect(shown!.expected_lines_balanced).toBe(true)
    expect(shown!.expected_lines).toEqual(await booked(w))
  })

  it('a whole-krona payment of an öre total: the öresavrundning is on the preview', async () => {
    const w: World = { row: { amount: 1500 }, invoice: { total: 1500.4, remaining_amount: 1500.4 } }
    const shown = await preview(w)
    expect(shown!.expected_lines).toContainEqual(expect.objectContaining({ account_number: '3740' }))
    expect(shown!.expected_lines).toEqual(await booked(w))
  })

  it('the bank leg is the row\'s own settlement account', async () => {
    mockSettlementAccount.mockResolvedValue('1940')
    const shown = await preview({ row: { cash_account_id: 'ca-2' } })
    expect(shown!.expected_lines[0]).toMatchObject({ account_number: '1940', debit: 1500 })
    expect(mockSettlementAccount.mock.calls[0]![2]).toBe('ca-2')
  })

  it('kontantmetoden, an invoice never booked, paid in full: revenue and moms, no 1510', async () => {
    const w: World = {
      invoice: { journal_entry_id: null, vat_treatment: 'standard_25', vat_rate: 25 },
      settings: { data: { accounting_method: 'cash', entity_type: 'aktiebolag' } },
    }
    const shown = await preview(w)
    expect(shown!.expected_lines_balanced).toBe(true)
    expect(shown!.expected_lines.map((l) => l.account_number)).not.toContain('1510')
    expect(shown!.expected_lines).toEqual(await booked(w))
  })
})

describe('customerMatchExpectedLines: a preview never refuses', () => {
  it('answers null when the accounting method cannot be read', async () => {
    expect(await preview({ settings: { data: null, error: { message: 'boom' } } })).toBeNull()
  })

  it('answers null for a shape the booking refuses (kontantmetoden, a part payment of a never-booked invoice)', async () => {
    expect(
      await preview({
        row: { amount: 500 },
        invoice: { journal_entry_id: null },
        settings: { data: { accounting_method: 'cash', entity_type: 'aktiebolag' } },
      }),
    ).toBeNull()
  })

  it('answers null when a foreign invoice has no booking rate, where the booking refuses', async () => {
    expect(
      await preview({
        row: { amount: 1040 },
        invoice: { currency: 'USD', exchange_rate: null, total: 100, remaining_amount: 100 },
      }),
    ).toBeNull()
  })
})
