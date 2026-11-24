/**
 * bookCustomerBankMatch: the one write sequence behind the dashboard, v1 and
 * the approval of a staged match. The doors' own suites pin what each door
 * answers; every row shape runs on real Postgres in
 * tests/pg/customer-bank-match-doors.pg.test.ts. Here: what only the function
 * can be asked, the compare-and-sets, the unwind, and what stands afterwards.
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
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(async () => []),
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
const { mockDetect, mockAppendHistory } = vi.hoisted(() => ({ mockDetect: vi.fn(), mockAppendHistory: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetect,
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: mockAppendHistory }))
const mockPropagateUnderlag = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/transactions/inbox-underlag', () => ({ propagateUnderlagForBookedTransaction: mockPropagateUnderlag }))
const mockFiledWarning = vi.hoisted(() => vi.fn())
vi.mock('@/lib/vat/voucher-filed-period-warning', () => ({ filedPeriodVoucherWarning: mockFiledWarning }))

const { cancelOrphanedEntry, createJournalEntry, findFiscalPeriod, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { logMatchEvent } = await import('@/lib/invoices/match-log')
const { bookCustomerBankMatch } = await import('../book-customer-bank-match')

const COMPANY = 'company-1'
const USER = 'user-1'
const TX = 'tx-1'
const INVOICE_ID = 'inv-1'
const PAYMENT_JE = 'je-payment'
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
  potential_invoice_id: INVOICE_ID,
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
  entries?: unknown[]
  claim?: { data?: unknown; error?: unknown }
  invoiceCas?: { data?: unknown; error?: unknown }
  paymentInsert?: { data?: unknown; error?: unknown }
}

function world(w: World = {}) {
  return createTableMockSupabase({
    transactions: [{ data: { ...ROW, ...w.row } }, w.claim ?? { data: [{ id: TX }] }, { data: null }],
    invoices: [{ data: { ...INVOICE, ...w.invoice } }, w.invoiceCas ?? { data: [{ id: INVOICE_ID }] }, { data: null }],
    transaction_voucher_links: { data: [] },
    journal_entries: { data: w.entries ?? [] },
    invoice_payments: [{ data: [] }, w.paymentInsert ?? { data: { id: 'ip-1' } }],
    company_settings: { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
    document_attachments: { data: null },
  })
}

function book(supabase: unknown, args: Record<string, unknown> = {}) {
  return bookCustomerBankMatch(
    { supabase: supabase as never, companyId: COMPANY, userId: USER, log },
    { transactionId: TX, invoiceId: INVOICE_ID, overrideVia: 'dashboard_force', ...args },
  )
}

type Recorded = { table: string; method: string; args: unknown[] }
const updatesOf = (calls: Recorded[], table: string) => calls.filter((c) => c.table === table && c.method === 'update')

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('POSTING_EVENTS', '')
  eventBus.clear()
  mockDetect.mockResolvedValue(null)
  mockAppendHistory.mockResolvedValue('evt-1')
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createJournalEntry).mockResolvedValue({ id: PAYMENT_JE } as never)
  vi.mocked(cancelOrphanedEntry).mockResolvedValue({ error: null })
  mockFiledWarning.mockResolvedValue(null)
})

describe('bookCustomerBankMatch: the claim', () => {
  it('claims a free row by a compare-and-set on its empty pointer, keeping its own category', async () => {
    const { supabase, calls } = world()

    const outcome = await book(supabase)

    expect(outcome).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE, invoiceStatus: 'paid', category: 'income_products' })
    const claim = updatesOf(calls, 'transactions')[0]!.args[0] as Record<string, unknown>
    expect(claim).toMatchObject({ invoice_id: INVOICE_ID, journal_entry_id: PAYMENT_JE, potential_invoice_id: null, reconciliation_method: null })
    expect(claim).not.toHaveProperty('category')
    const filters = calls.filter((c) => c.table === 'transactions' && (c.method === 'is' || c.method === 'eq')).map((c) => c.args)
    expect(filters).toContainEqual(['journal_entry_id', null])
    expect(filters).toContainEqual(['invoice_id', null])
  })

  it('claims a stale pointer by that pointer, and reverses nothing', async () => {
    const { supabase, calls } = world({
      row: { journal_entry_id: 'je-reversed' },
      entries: [{ id: 'je-reversed', status: 'reversed', source_type: 'bank_transaction', source_id: TX }],
    })

    expect(await book(supabase)).toMatchObject({ ok: true })

    expect(calls.filter((c) => c.table === 'transactions' && c.method === 'eq').map((c) => c.args)).toContainEqual(['journal_entry_id', 'je-reversed'])
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('cancels the verifikat when another booking took the row between the gate and the claim', async () => {
    const { supabase, calls } = world({ claim: { data: [] } })

    const outcome = await book(supabase)

    expect(outcome).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_TX_ALREADY_BOOKED',
      details: { via: 'concurrent', voucher: null },
    })
    expect(cancelOrphanedEntry).toHaveBeenCalledTimes(1)
    expect(updatesOf(calls, 'invoices')).toEqual([])
  })

  it('cancels the verifikat when the claim fails: the row\'s guards are the database\'s last word', async () => {
    const { supabase } = world({ claim: { error: { message: 'already booked on verifikat' } } })

    expect(await book(supabase)).toMatchObject({ ok: false, code: 'MATCH_INVOICE_LINK_TX_FAILED' })
    expect(cancelOrphanedEntry).toHaveBeenCalledTimes(1)
  })
})

describe('bookCustomerBankMatch: a match that stops after the verifikat posted', () => {
  it('releases the row and cancels the verifikat when a concurrent request settled the invoice', async () => {
    const { supabase, calls } = world({ invoiceCas: { data: [] } })

    expect(await book(supabase)).toMatchObject({ ok: false, code: 'MATCH_INVOICE_ALREADY_PAID' })

    expect(updatesOf(calls, 'transactions').at(-1)?.args[0]).toMatchObject({ invoice_id: null, journal_entry_id: null })
    expect(cancelOrphanedEntry).toHaveBeenCalledTimes(1)
  })

  it('on a 23505 payment row undoes the invoice and the claim and cancels the verifikat', async () => {
    const { supabase, calls } = world({ paymentInsert: { error: { code: '23505', message: 'duplicate' } } })

    expect(await book(supabase)).toMatchObject({ ok: false, code: 'MATCH_INVOICE_DUPLICATE_PAYMENT' })

    expect(updatesOf(calls, 'invoices').at(-1)?.args[0]).toMatchObject({ status: 'sent', paid_at: null, paid_amount: 0, remaining_amount: 1500 })
    expect(updatesOf(calls, 'transactions').at(-1)?.args[0]).toMatchObject({ invoice_id: null, journal_entry_id: null })
    expect(cancelOrphanedEntry).toHaveBeenCalledTimes(1)
  })

  it('restores a stale pointer and a suggestion on the released row', async () => {
    const { supabase, calls } = world({
      row: { journal_entry_id: 'je-reversed' },
      entries: [{ id: 'je-reversed', status: 'reversed' }],
      invoiceCas: { data: [] },
    })

    await book(supabase)

    expect(updatesOf(calls, 'transactions').at(-1)?.args[0]).toMatchObject({ journal_entry_id: 'je-reversed', potential_invoice_id: INVOICE_ID })
  })

  it('names the verifikat when it could not be cancelled: a partial commit, never a clean refusal', async () => {
    vi.mocked(cancelOrphanedEntry).mockResolvedValue({ error: { message: 'refused' } })
    const { supabase } = world({ invoiceCas: { data: [] } })

    expect(await book(supabase)).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_ALREADY_PAID',
      partialPostedIds: { payment_journal_entry_id: PAYMENT_JE },
      details: { posted_ids: { payment_journal_entry_id: PAYMENT_JE } },
    })
  })
})

describe('bookCustomerBankMatch: the row\'s own underlag', () => {
  it('runs the one step on the payment verifikat, once', async () => {
    const { supabase } = world()

    expect(await book(supabase)).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE })

    expect(mockPropagateUnderlag).toHaveBeenCalledTimes(1)
    expect(mockPropagateUnderlag).toHaveBeenCalledWith(supabase, COMPANY, TX, PAYMENT_JE)
  })

  it('anchors nothing on a verifikat the match cancels: anchoring cannot be undone', async () => {
    const { supabase } = world({ paymentInsert: { error: { code: 'XX000', message: 'boom' } } })

    expect(await book(supabase)).toMatchObject({ ok: false })

    expect(mockPropagateUnderlag).not.toHaveBeenCalled()
  })

  it('a refused match runs no step', async () => {
    const { supabase } = world({ row: { journal_entry_id: 'je-other' }, entries: [{ id: 'je-other', status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 1 }] })

    expect(await book(supabase)).toMatchObject({ ok: false })

    expect(mockPropagateUnderlag).not.toHaveBeenCalled()
  })
})

describe('bookCustomerBankMatch: what every door now gets', () => {
  const candidate = {
    journal_entry_id: 'je-manual',
    voucher_label: 'A9',
    entry_date: '2026-09-28',
    description: 'Inbetalning',
    amount: 1500,
    bank_account_number: '1930',
    reason: 'exact_amount_same_date',
    amount_verified: true,
    unverified_reason: null,
  }

  it('records an honoured duplicate override in behandlingshistorik, naming the door', async () => {
    mockDetect.mockResolvedValue(candidate)
    const { supabase } = world()

    expect(await book(supabase, { force: true, expectedJournalEntryId: 'je-manual', overrideVia: 'v1_force' })).toMatchObject({ ok: true })

    expect(mockAppendHistory.mock.calls[0]![0]).toMatchObject({
      eventType: 'BankTransactionDuplicateDismissed',
      payload: { dismissed_journal_entry_id: 'je-manual', via: 'v1_force' },
    })
  })

  it('refuses an override it cannot re-verify: a failed detection with force books nothing', async () => {
    mockDetect.mockRejectedValue(new Error('scan failed'))
    const { supabase } = world()

    expect(await book(supabase, { force: true, expectedJournalEntryId: 'je-manual' })).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('writes the match log and the invoice PDF on the payment verifikat', async () => {
    const { supabase, calls } = createTableMockSupabase({
      transactions: [{ data: ROW }, { data: [{ id: TX }] }],
      invoices: [{ data: INVOICE }, { data: [{ id: INVOICE_ID }] }],
      transaction_voucher_links: { data: [] },
      journal_entries: { data: [] },
      invoice_payments: [{ data: [] }, { data: { id: 'ip-1' } }],
      company_settings: { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
      document_attachments: [
        { data: { storage_path: 'a/b.pdf', file_name: 'b.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x' } },
        { data: null },
      ],
    })

    expect(await book(supabase)).toMatchObject({ ok: true })

    expect(calls.filter((c) => c.table === 'document_attachments' && c.method === 'insert')[0]?.args[0]).toMatchObject({
      journal_entry_id: PAYMENT_JE,
      file_name: 'b.pdf',
    })
    expect(logMatchEvent).toHaveBeenCalledWith(supabase, USER, TX, 'matched', expect.objectContaining({ invoiceId: INVOICE_ID, matchMethod: 'manual_confirm' }))
  })

  it('refuses when the excess shown is no longer the excess there is', async () => {
    const { supabase } = world({ row: { amount: 2000 } })

    expect(await book(supabase, { overpaymentAccount: '2420', overpaymentAmount: 400 })).toMatchObject({
      ok: false,
      code: 'MATCH_OVERPAYMENT_CHANGED',
      details: { shown_excess: 400, current_excess: 500 },
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an excess the approver saw that is gone: a payment landed since', async () => {
    const { supabase } = world({ row: { amount: 1500 } })

    expect(await book(supabase, { overpaymentAccount: '2420', overpaymentAmount: 500 })).toMatchObject({
      ok: false,
      code: 'MATCH_OVERPAYMENT_CHANGED',
      details: { shown_excess: 500, current_excess: 0 },
    })
  })
})

describe('bookCustomerBankMatch: a match nobody confirmed (crm#2226)', () => {
  const unattended = {
    match: { method: 'auto_exact_reference', confidence: 0.99 },
    linkBasis: { basis: 'rule_ocr_reference' as const, evidence: { rule_id: 'customer_payment_exact_reference', score: 0.99 } },
  }

  it('books with the rule as the link basis and logs it as auto_matched', async () => {
    const { supabase, calls } = world()

    expect(await book(supabase, { unattended })).toMatchObject({ ok: true, journalEntryId: PAYMENT_JE, invoiceStatus: 'paid' })

    const claim = updatesOf(calls, 'transactions')[0]!.args[0] as Record<string, unknown>
    expect(claim).toMatchObject({
      invoice_id: INVOICE_ID,
      link_basis: 'rule_ocr_reference',
      link_evidence: { rule_id: 'customer_payment_exact_reference', score: 0.99 },
    })
    expect(logMatchEvent).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      TX,
      'auto_matched',
      expect.objectContaining({ invoiceId: INVOICE_ID, matchMethod: 'auto_exact_reference', matchConfidence: 0.99 }),
    )
    expect(mockFiledWarning).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY,
      expect.objectContaining({ entry_date: ROW.date }),
      'bank_row',
    )
  })

  it('a person\'s match keeps user_confirmed and manual_confirm, and asks nothing about filed periods', async () => {
    const { supabase, calls } = world()

    expect(await book(supabase)).toMatchObject({ ok: true })

    expect(updatesOf(calls, 'transactions')[0]!.args[0]).toMatchObject({ link_basis: 'user_confirmed' })
    expect(logMatchEvent).toHaveBeenCalledWith(expect.anything(), USER, TX, 'matched', expect.objectContaining({ matchMethod: 'manual_confirm' }))
    expect(mockFiledWarning).not.toHaveBeenCalled()
  })

  it('refuses before anything is written when the verifikat would move a filed momsdeklaration', async () => {
    mockFiledWarning.mockResolvedValue({
      code: 'VAT_PERIOD_ALREADY_FILED',
      message_sv: '',
      message_en: '',
      details: { entry_date: ROW.date, filed_periods: [{ tax_period: '2026-09' }] },
    })
    const { supabase, calls } = world()

    const outcome = await book(supabase, { unattended })

    expect(outcome).toMatchObject({ ok: false, code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD' })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(updatesOf(calls, 'transactions')).toEqual([])
    expect(updatesOf(calls, 'invoices')).toEqual([])
  })

  it('refuses when the filed period check cannot be made', async () => {
    mockFiledWarning.mockRejectedValue(new Error('read failed'))
    const { supabase } = world()

    expect(await book(supabase, { unattended })).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD',
      details: { check_failed: true },
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('keeps every refusal a person\'s match has: an excess of a krona or more is not booked', async () => {
    const { supabase } = world({ row: { amount: 1600 } })

    const outcome = await book(supabase, { unattended })

    expect(outcome.ok).toBe(false)
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})
