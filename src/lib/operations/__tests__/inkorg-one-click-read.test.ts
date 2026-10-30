import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

const readBankMatchMock = vi.fn()
// Booking review rules (accounted#130): none in these tests; the queued mock
// would otherwise hand their read a response queued for the operation.
vi.mock('@/lib/booking-review/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/booking-review/rules')>()),
  loadActiveBookingReviewRules: vi.fn(async () => []),
}))
vi.mock('@/lib/documents/inbox-bank-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/inbox-bank-match')>()),
  readInboxBankMatch: (...args: unknown[]) => readBankMatchMock(...args),
}))
const pairingsMock = vi.fn()
vi.mock('@/lib/operations/inbox-pairings', () => ({ readInboxPairings: (...args: unknown[]) => pairingsMock(...args) }))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({ resolveSettlementAccount: vi.fn(async () => '2890') }))
const capabilitiesMock = vi.fn()
vi.mock('@/lib/modules/capabilities', () => ({ loadCompanyCapabilities: (...args: unknown[]) => capabilitiesMock(...args) }))
const matchSupplierMock = vi.fn()
vi.mock('@/lib/suppliers/match-supplier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suppliers/match-supplier')>()),
  matchSupplierByIdentity: (...args: unknown[]) => matchSupplierMock(...args),
}))
const categoriesMock = vi.fn()
vi.mock('@/lib/categories/inbox-purchase-category', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories/inbox-purchase-category')>()),
  resolveInboxPurchaseCategories: (...args: unknown[]) => categoriesMock(...args),
}))
const templateMock = vi.fn()
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplate: (...args: unknown[]) => templateMock(...args),
}))

const directBookingMock = vi.fn()
vi.mock('@/lib/transactions/direct-booking-settings', () => ({
  readDirectBookingSettings: (...args: unknown[]) => directBookingMock(...args),
}))

import { readOneClickInput } from '../inkorg-one-click-read'

const { supabase, enqueueMany, findCalls, reset } = createQueuedMockSupabase()
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

const READING = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Wispr Flow', orgNumber: null, vatNumber: null, address: 'San Francisco, CA 94114' },
  invoice: { invoiceNumber: 'WF-1', invoiceDate: '2026-10-13', currency: 'SEK' },
  totals: { total: 150, vatAmount: 0 },
  lineItems: [],
  vatBreakdown: [],
}

const ITEM = {
  id: 'item-1',
  status: 'received',
  source: 'email',
  document_id: 'doc-1',
  kind_hint: null,
  extracted_data: READING,
  routed_to_arkiv_at: null,
  matched_supplier_id: null,
  matched_transaction_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  bank_match_transaction_id: 'tx-1',
  bank_match_basis: 'rule_amount_date',
  bank_match_evidence_level: 'stark',
  bank_match_source_key: 'v1:x',
  email_subject: 'Your receipt',
}

const TX = { id: 'tx-1', date: '2026-10-14', amount: -150, currency: 'SEK', amount_sek: -150, exchange_rate: null, cash_account_id: 'ca-card', journal_entry_id: null, description: 'WISPR K3667', merchant_name: null }

const read = (answers = {}) => readOneClickInput(supabase as unknown as SupabaseClient, 'company-1', 'item-1', answers, log)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  readBankMatchMock.mockResolvedValue({ transaction_id: 'tx-1', date: '2026-10-14', amount: -150, currency: 'SEK', counterparty: 'WISPR K3667', basis: 'rule_amount_date', evidence_level: 'stark' })
  pairingsMock.mockResolvedValue(new Map())
  capabilitiesMock.mockResolvedValue(null)
  directBookingMock.mockResolvedValue({ enabled: true })
  matchSupplierMock.mockResolvedValue(null)
  categoriesMock.mockResolvedValue(new Map([['item-1', { code: 'expense.software.saas', source: 'lines', level: 'Trolig', version: 'pc-2026-10' }]]))
  templateMock.mockResolvedValue(null)
})

describe('readOneClickInput', () => {
  it('reads the item, the arrival match\'s bank row on its own settlement account, and the category', async () => {
    enqueueMany([{ data: ITEM }, { data: TX }, { data: { vat_registered: true, accounting_method: 'accrual', entity_type: 'aktiebolag' } }])
    const result = await read()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input).toMatchObject({
      kind: 'supplier_invoice',
      paidByReceipt: false,
      bank: { transactionId: 'tx-1', date: '2026-10-14', amountSek: -150, settlementAccount: '2890', source: 'proposal' },
      company: { vatRegistered: true, cashMethod: false, supplierInvoices: true },
      category: 'expense.software.saas',
      supplier: null,
      sellerRegionAnswer: null,
    })
    expect(result.item).toMatchObject({ id: 'item-1', documentId: 'doc-1', description: 'Wispr Flow' })
    // Every read is the company's.
    for (const table of ['invoice_inbox_items', 'transactions', 'company_settings']) {
      expect(findCalls(table, 'eq')).toContainEqual(['company_id', 'company-1'])
    }
  })

  it('reads the row an item is linked to, and refuses one booked since', async () => {
    enqueueMany([{ data: { ...ITEM, matched_transaction_id: 'tx-1' } }, { data: TX }, { data: { vat_registered: true, accounting_method: 'accrual' } }])
    const linked = await read()
    expect(linked.ok && linked.input.bank?.source).toBe('matched')
    expect(readBankMatchMock).not.toHaveBeenCalled()

    reset()
    enqueueMany([{ data: { ...ITEM, matched_transaction_id: 'tx-1' } }, { data: { ...TX, journal_entry_id: 'je-1' } }])
    expect(await read()).toEqual({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: 'item-1' } })
  })

  it('answers not found, already booked and already registered', async () => {
    enqueueMany([{ data: null }])
    expect(await read()).toEqual({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    enqueueMany([{ data: { ...ITEM, created_journal_entry_id: 'je-1' } }])
    expect((await read()).ok).toBe(false)
    enqueueMany([{ data: { ...ITEM, created_supplier_invoice_id: 'si-1' } }])
    expect(await read()).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED' })
  })

  it('reads an invoice paid by its receipt, with the receipt\'s date', async () => {
    pairingsMock.mockResolvedValue(new Map([['item-1', { role: 'invoice', receipt_item_id: 'item-2', basis: 'invoice_number' }]]))
    enqueueMany([
      { data: ITEM },
      { data: TX },
      { data: { id: 'item-2', extracted_data: { invoice: { invoiceDate: '2026-10-12' } } } },
      { data: { vat_registered: true, accounting_method: 'accrual' } },
    ])
    const result = await read()
    expect(result.ok && [result.input.paidByReceipt, result.input.receiptDate]).toEqual([true, '2026-10-12'])
  })

  it('takes the person\'s answers over what the item reads as', async () => {
    enqueueMany([{ data: ITEM }, { data: TX }, { data: { vat_registered: true, accounting_method: 'cash' } }])
    const result = await read({ purchaseCategory: 'expense.marketing.ads', sellerRegion: 'eu' })
    expect(result.ok && [result.input.category, result.input.sellerRegionAnswer, result.input.company.cashMethod]).toEqual(['expense.marketing.ads', 'eu', true])
    expect(categoriesMock).not.toHaveBeenCalled()
  })

  it('finds the supplier by identity, and the account the counterparty is booked on', async () => {
    matchSupplierMock.mockResolvedValue({ supplierId: 'sup-1', matchedOn: 'name' })
    templateMock.mockResolvedValue({ confidence: 0.9, matchMethod: 'exact_alias', template: { debit_account: '6540', credit_account: '1930', line_pattern: null, source: 'learned' } })
    enqueueMany([
      { data: ITEM },
      { data: TX },
      { data: { vat_registered: true, accounting_method: 'accrual' } },
      { data: { id: 'sup-1', supplier_type: 'non_eu_business', default_expense_account: null, default_payment_terms: 10, archived_at: null } },
    ])
    const result = await read()
    expect(result.ok && result.input.supplier).toEqual({ id: 'sup-1', supplierType: 'non_eu_business', defaultExpenseAccount: null, paymentTermsDays: 10 })
    expect(result.ok && result.input.counterpartyAccount).toBe('6540')
    expect(result.ok && result.input.counterpartyAlwaysReview).toBe(false)
  })

  it("reads the company's one-click switch and whether the counterpart's rule always asks (accounted#130)", async () => {
    directBookingMock.mockResolvedValue({ enabled: false })
    templateMock.mockResolvedValue({
      confidence: 0.9,
      matchMethod: 'exact_alias',
      template: { debit_account: '6540', credit_account: '1930', line_pattern: null, source: 'sie_import', always_review: true },
    })
    enqueueMany([{ data: ITEM }, { data: TX }, { data: { vat_registered: true, accounting_method: 'accrual' } }])
    const result = await read()
    expect(directBookingMock).toHaveBeenCalledWith(supabase, 'company-1')
    expect(result.ok && result.input.directBooking).toEqual({ enabled: false })
    expect(result.ok && result.input.counterpartyAlwaysReview).toBe(true)
    // An imported rule's account still informs the plan: the Inkorg never books on the history count.
    expect(result.ok && result.input.counterpartyAccount).toBe('6540')
  })

  it('never takes a system default template as the company\'s history', async () => {
    templateMock.mockResolvedValue({ confidence: 0.9, matchMethod: 'exact_alias', template: { debit_account: '6540', credit_account: '1930', line_pattern: null, source: 'sni_default' } })
    enqueueMany([{ data: ITEM }, { data: TX }, { data: { vat_registered: true, accounting_method: 'accrual' } }])
    const result = await read()
    expect(result.ok && result.input.counterpartyAccount).toBeNull()
  })

  it('plans without a hint that cannot be read', async () => {
    categoriesMock.mockRejectedValue(new Error('down'))
    readBankMatchMock.mockRejectedValue(new Error('down'))
    enqueueMany([{ data: ITEM }, { data: { vat_registered: true, accounting_method: 'accrual' } }])
    const result = await read()
    expect(result.ok && [result.input.category, result.input.bank]).toEqual([null, null])
    expect(log.warn).toHaveBeenCalled()
  })
})
