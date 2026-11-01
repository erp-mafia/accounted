/**
 * accounted#58: a supplier match on a bank row that is already booked posted a
 * second payment verifikat and left the first one posted with no row, so the
 * bank account was credited twice. bookSupplierBankMatch is the one booking
 * function behind every door (dashboard, v1, the Inkorg, the payment order's
 * own debit), so the refusal lives here:
 *
 *   - a booked row is refused with MATCH_SI_TX_ALREADY_BOOKED, naming the
 *     verifikat, before anything is written;
 *   - only the row's own categorization may be reversed, and only with
 *     stornoExisting, after every other refusal has had its say;
 *   - the bank row is claimed by a compare-and-set right after the payment
 *     verifikat posts, and a match that stops after that undoes its own
 *     writes and cancels the verifikat (the 23505 used to leave it posted).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CreateJournalEntryLineInput, SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  cancelOrphanedEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(async () => []),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitSupplierInvoicePaidIfSettled: vi.fn(async () => undefined),
}))

const { createJournalEntry, findFiscalPeriod, cancelOrphanedEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { findUnresolvableAccounts } = await import('@/lib/bookkeeping/account-validation')
const { logMatchEvent } = await import('@/lib/invoices/match-log')
const { bookSupplierBankMatch } = await import('../book-supplier-bank-match')

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const TX = '00000000-0000-4000-8000-0000000a0001'
const SI = '00000000-0000-4000-8000-000000000001'
const OWN_JE = '00000000-0000-4000-8000-00000000e0c1'
const PAYMENT_JE = 'je-payment'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

const INVOICE = {
  id: SI,
  company_id: COMPANY,
  supplier_id: 'sup-1',
  arrival_number: 81,
  supplier_invoice_number: 'F-4001',
  invoice_date: '2026-09-01',
  due_date: '2026-09-30',
  status: 'registered',
  currency: 'SEK',
  exchange_rate: null,
  subtotal: 1200,
  vat_amount: 300,
  total: 1500,
  total_sek: 1500,
  vat_treatment: 'standard_25',
  reverse_charge: false,
  paid_amount: 0,
  remaining_amount: 1500,
  paid_at: null,
  payment_journal_entry_id: null,
  transaction_id: null,
  registration_journal_entry_id: 'je-registration',
  supplier: { id: 'sup-1', name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
  items: [
    { id: 'item-0', description: 'Skärmar', quantity: 1, unit_price: 1200, line_total: 1200, account_number: '5410', vat_rate: 0.25, vat_amount: 300 },
  ] as unknown as SupplierInvoiceItem[],
} as unknown as SupplierInvoice

/** The row a categorize door booked: its own verifikat A12 on the pointer. */
const OWN_ENTRY = {
  id: OWN_JE,
  status: 'posted',
  source_type: 'bank_transaction',
  source_id: TX,
  voucher_series: 'A',
  voucher_number: 12,
}

interface RowState {
  journal_entry_id?: string | null
  reconciliation_method?: Transaction['reconciliation_method']
  is_business?: boolean | null
}

function row(state: RowState = {}) {
  return {
    id: TX,
    date: '2026-09-28',
    amount: -1500,
    currency: 'SEK' as const,
    amount_sek: null,
    cash_account_id: null,
    document_id: null,
    potential_supplier_invoice_id: SI,
    is_business: state.is_business ?? null,
    journal_entry_id: state.journal_entry_id ?? null,
    reconciliation_method: state.reconciliation_method ?? null,
  }
}

/** Answers per chain: a write's own answer by its method, a read's by table. */
function byMethod(answers: { update?: unknown; select?: unknown; insert?: unknown }): TableMockResolver {
  return (calls) => {
    const method = calls.some((c) => c.method === 'update') ? 'update' : calls.some((c) => c.method === 'insert') ? 'insert' : 'select'
    const answer = answers[method]
    return (answer ?? { data: null }) as { data?: unknown; error?: unknown }
  }
}

interface World {
  links?: Array<{ journal_entry_id: string; role: string }>
  entries?: Array<Record<string, unknown>>
  /** The row claim's answer: the claimed rows, or an empty list when another booking won. */
  claim?: { data?: unknown; error?: unknown }
  /** With a pointer read: the second claim's answer (row unbooked), after the first missed. */
  claimUnbooked?: { data?: unknown; error?: unknown }
  /** The invoice status CAS's answer. */
  invoiceCas?: { data?: unknown; error?: unknown }
  paymentInsert?: { data?: unknown; error?: unknown }
  linksError?: boolean
}

function world(w: World = {}) {
  return createTableMockSupabase({
    company_settings: { data: { accounting_method: 'accrual' } },
    transaction_voucher_links: w.linksError ? { error: { message: 'timeout' } } : { data: w.links ?? [] },
    journal_entries: { data: w.entries ?? [] },
    transactions: [w.claim ?? { data: [{ id: TX }] }, ...(w.claimUnbooked ? [w.claimUnbooked] : []), { data: [{ id: TX }] }],
    supplier_invoices: [w.invoiceCas ?? { data: [{ id: SI }] }, { data: [{ id: SI }] }],
    supplier_invoice_payments: byMethod({ insert: w.paymentInsert ?? { data: null } }),
    document_attachments: { data: null },
    business_events: { data: null },
  })
}

async function match(
  supabase: unknown,
  state: RowState,
  opts: { stornoExisting?: boolean; customLines?: CreateJournalEntryLineInput[] } = {},
) {
  return bookSupplierBankMatch(supabase as never, {
    transaction: row(state),
    invoice: INVOICE,
    userId: USER,
    companyId: COMPANY,
    log,
    customLines: opts.customLines ?? null,
    match: { action: 'matched', method: 'manual_confirm', confidence: 1 },
    linkBasis: { basis: 'user_confirmed' },
    ...(opts.stornoExisting ? { stornoExisting: true } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POSTING_EVENTS', '')
  eventBus.clear()
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createJournalEntry).mockResolvedValue({ id: PAYMENT_JE } as never)
  vi.mocked(cancelOrphanedEntry).mockResolvedValue({ error: null })
  vi.mocked(reverseEntry).mockResolvedValue({ id: 'je-storno' } as never)
  vi.mocked(findUnresolvableAccounts).mockResolvedValue([])
})

describe('bookSupplierBankMatch on a bank row that is already booked (accounted#58)', () => {
  it("refuses the row's own categorization and names it, writing nothing (the reported case)", async () => {
    const { supabase, tables } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE, is_business: true })

    expect(result).toEqual({
      ok: false,
      code: 'MATCH_SI_TX_ALREADY_BOOKED',
      details: { journal_entry_id: OWN_JE, voucher: 'A12', via: 'pointer', storno_allowed: true },
    })
    // No second verifikat, no storno, no ledger update, no payment row.
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(tables()).not.toContain('supplier_invoices')
    expect(tables()).not.toContain('supplier_invoice_payments')
    expect(tables()).not.toContain('transactions')
  })

  it('refuses a row booked only through a samlingsverifikat link, and never offers the storno', async () => {
    const samling = { ...OWN_ENTRY, id: 'je-samling', source_type: 'manual', source_id: null, voucher_number: 40 }
    const { supabase } = world({ links: [{ journal_entry_id: 'je-samling', role: 'bank_line' }], entries: [samling] })
    const result = await match(supabase, {}, { stornoExisting: true })

    expect(result).toMatchObject({
      ok: false,
      code: 'MATCH_SI_TX_ALREADY_BOOKED',
      details: { journal_entry_id: 'je-samling', voucher: 'A40', via: 'link', storno_allowed: false },
    })
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a reconciliation-linked row even with stornoExisting', async () => {
    const sie = { ...OWN_ENTRY, id: 'je-sie', source_type: 'import', source_id: null, voucher_number: 3 }
    const { supabase } = world({ entries: [sie] })
    const result = await match(supabase, { journal_entry_id: 'je-sie', reconciliation_method: 'manual' }, { stornoExisting: true })

    expect(result).toMatchObject({ ok: false, code: 'MATCH_SI_TX_ALREADY_BOOKED', details: { via: 'reconciliation', storno_allowed: false } })
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an ignored row before a verifikat posts: the claim could not land on it', async () => {
    const { supabase, calls } = world()

    const outcome = await bookSupplierBankMatch(supabase as never, {
      transaction: { ...row(), is_ignored: true },
      invoice: INVOICE,
      userId: USER,
      companyId: COMPANY,
      log,
      match: { action: 'matched', method: 'manual_confirm', confidence: 1 },
      linkBasis: { basis: 'user_confirmed' },
    })

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_ROW_IGNORED' })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('refuses when the booked-state read fails, with a retry: the failed read says nothing about the row', async () => {
    const { supabase } = world({ linksError: true })
    const result = await match(supabase, {})
    expect(result).toMatchObject({ ok: false, code: 'BANK_ROW_READ_FAILED', details: { via: 'read_error', journal_entry_id: null } })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('books a row whose pointer names a reversed verifikat', async () => {
    const { supabase, findCalls } = world({ entries: [{ ...OWN_ENTRY, status: 'reversed' }] })
    const result = await match(supabase, { journal_entry_id: OWN_JE })

    expect(result).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE })
    expect(reverseEntry).not.toHaveBeenCalled()
    // The claim accepts the stale pointer the gate read first, as a literal
    // compare-and-set (no interpolated .or()).
    expect(findCalls('transactions', 'or')).toEqual([])
    expect(findCalls('transactions', 'eq')).toContainEqual(['journal_entry_id', OWN_JE])
  })

  it('claims the row once its stale pointer is gone: the pointer read first, then none', async () => {
    const { supabase, findCalls } = world({
      entries: [{ ...OWN_ENTRY, status: 'reversed' }],
      claim: { data: [] }, // the pointer read is no longer on the row
      claimUnbooked: { data: [{ id: TX }] },
    })
    const result = await match(supabase, { journal_entry_id: OWN_JE })

    expect(result).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE })
    expect(findCalls('transactions', 'eq')).toContainEqual(['journal_entry_id', OWN_JE])
    expect(findCalls('transactions', 'is')).toContainEqual(['journal_entry_id', null])
    expect(cancelOrphanedEntry).not.toHaveBeenCalled()
  })

  it('cancels the payment verifikat when both claims miss: another booking holds the row', async () => {
    const { supabase, tables } = world({
      entries: [{ ...OWN_ENTRY, status: 'reversed' }],
      claim: { data: [] },
      claimUnbooked: { data: [] },
    })
    const result = await match(supabase, { journal_entry_id: OWN_JE })

    expect(result).toMatchObject({ ok: false, code: 'MATCH_SI_TX_ALREADY_BOOKED', details: { via: 'concurrent' } })
    expect(cancelOrphanedEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, PAYMENT_JE, expect.anything())
    expect(tables()).not.toContain('supplier_invoices')
  })

  it("with stornoExisting reverses the row's own categorization once, then books the payment", async () => {
    const { supabase, findCalls, payloads } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE, is_business: true }, { stornoExisting: true })

    expect(result).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE })
    expect(reverseEntry).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reverseEntry).mock.calls[0]!.slice(1, 4)).toEqual([COMPANY, USER, OWN_JE])
    // The storno runs before the payment verifikat.
    expect(vi.mocked(reverseEntry).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createJournalEntry).mock.invocationCallOrder[0]!)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    expect(logMatchEvent).toHaveBeenCalledWith(expect.anything(), USER, TX, 'storno_conflict_resolved', {
      supplierInvoiceId: SI,
      previousState: { journal_entry_id: OWN_JE },
      newState: { journal_entry_id: null },
    })
    // The row is claimed for the payment, by a compare-and-set.
    expect(payloads('transactions', 'update')[0]).toMatchObject({
      supplier_invoice_id: SI,
      journal_entry_id: PAYMENT_JE,
      reconciliation_method: null,
    })
    expect(findCalls('transactions', 'is')).toContainEqual(['supplier_invoice_id', null])
    expect(cancelOrphanedEntry).not.toHaveBeenCalled()
  })

  it('reverses nothing when a later check refuses the match (unbalanced custom lines)', async () => {
    const { supabase } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE }, {
      stornoExisting: true,
      customLines: [
        { account_number: '2440', debit_amount: 1500, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1400 },
      ],
    })
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_LINES_UNBALANCED' })
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('reverses nothing when edited lines name an account the engine cannot resolve (crm#1550)', async () => {
    vi.mocked(findUnresolvableAccounts).mockResolvedValue(['8022'])
    const { supabase } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE }, {
      stornoExisting: true,
      customLines: [
        { account_number: '2440', debit_amount: 1500, credit_amount: 0 },
        { account_number: '8022', debit_amount: 0, credit_amount: 1500 },
      ],
    })
    expect(result).toMatchObject({ ok: false, code: 'ACCOUNTS_NOT_IN_CHART' })
    expect(findUnresolvableAccounts).toHaveBeenCalledWith(supabase, COMPANY, ['2440', '8022'])
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('reverses nothing when the payment account is not in the chart', async () => {
    vi.mocked(findUnresolvableAccounts).mockResolvedValue(['1930'])
    const { supabase } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE }, { stornoExisting: true })
    expect(result).toMatchObject({ ok: false, code: 'ACCOUNTS_NOT_IN_CHART' })
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('stops when the storno is refused, before any payment verifikat', async () => {
    vi.mocked(reverseEntry).mockRejectedValue(Object.assign(new Error('period locked'), { code: 'PERIOD_LOCKED' }))
    const { supabase } = world({ entries: [OWN_ENTRY] })
    const result = await match(supabase, { journal_entry_id: OWN_JE }, { stornoExisting: true })
    expect(result).toMatchObject({ ok: false })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

describe('bookSupplierBankMatch after the payment verifikat posts', () => {
  it('claims an unbooked row by a compare-and-set on its empty pointer', async () => {
    const { supabase, findCalls } = world()
    const result = await match(supabase, {})
    expect(result).toMatchObject({ ok: true })
    expect(findCalls('transactions', 'is')).toEqual([
      ['supplier_invoice_id', null],
      ['journal_entry_id', null],
    ])
  })

  it('cancels the payment verifikat when another booking claimed the row first', async () => {
    const { supabase, tables } = world({ claim: { data: [] } })
    const result = await match(supabase, {})

    expect(result).toMatchObject({ ok: false, code: 'MATCH_SI_TX_ALREADY_BOOKED', details: { via: 'concurrent' } })
    expect(cancelOrphanedEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, PAYMENT_JE, expect.anything())
    expect(tables()).not.toContain('supplier_invoices')
    expect(tables()).not.toContain('supplier_invoice_payments')
  })

  it('releases the row and cancels the verifikat when a concurrent request settled the invoice', async () => {
    const { supabase, payloads, findCalls } = world({ invoiceCas: { data: [] } })
    const result = await match(supabase, {})

    expect(result).toEqual({ ok: false, code: 'MATCH_SI_NOT_OPEN' })
    expect(payloads('transactions', 'update')[1]).toEqual({
      supplier_invoice_id: null,
      potential_supplier_invoice_id: SI,
      journal_entry_id: null,
      is_business: null,
    })
    expect(findCalls('transactions', 'eq')).toContainEqual(['journal_entry_id', PAYMENT_JE])
    expect(cancelOrphanedEntry).toHaveBeenCalledTimes(1)
  })

  it('on a 23505 payment row undoes the ledger update and the claim and cancels the verifikat', async () => {
    const { supabase, payloads, findCalls } = world({ paymentInsert: { error: { code: '23505', message: 'duplicate key' } } })
    const result = await match(supabase, {})

    expect(result).toEqual({ ok: false, code: 'MATCH_SI_DUPLICATE_PAYMENT' })
    // The invoice goes back to what was read, behind a CAS on this call's verifikat.
    expect(payloads('supplier_invoices', 'update')[1]).toEqual({
      status: 'registered',
      remaining_amount: 1500,
      paid_amount: 0,
      paid_at: null,
      payment_journal_entry_id: null,
      transaction_id: null,
    })
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['payment_journal_entry_id', PAYMENT_JE])
    expect(payloads('transactions', 'update')[1]).toMatchObject({ supplier_invoice_id: null, journal_entry_id: null })
    // It used to leave the payment verifikat posted.
    expect(cancelOrphanedEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, PAYMENT_JE, expect.anything())
  })
})
