import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import { bankMatchCheckKey, bankMatchSourceKey } from '@/lib/documents/inbox-bank-match'
import type { DocumentReading, ReadingFields } from '@/lib/documents/reading/types'

const loadDocumentReading = vi.fn()
vi.mock('@/lib/documents/reading/load', () => ({
  loadDocumentReading: (...args: unknown[]) => loadDocumentReading(...args),
}))

import {
  ITEMS_REFRESHED_PER_ARRIVAL,
  OPEN_ITEMS_SCANNED,
  RIVALS_READ,
  mayBePaidBy,
  refreshInboxBankMatchesForTransactions,
  refreshInboxItemBankMatch,
  type BankMatchRefreshRules,
} from '../refresh'

const COMPANY = 'company-1'
const RULES: BankMatchRefreshRules = { matchSupplierInvoice: findSupplierInvoiceMatch, counterpartyGiroDigits, giroKey }
const DEPS = { today: '2026-10-16', rateFor: vi.fn(async () => 10.5) }

const READ = {
  supplier: { name: 'Kontorsbolaget AB' },
  invoice: { invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'SEK', paymentReference: '4711000123' },
  totals: { total: 1250 },
}

function reading(fields: Record<string, unknown>): DocumentReading {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) out[name] = { value, source: 'vision', evidence: 'trolig' }
  return { document_id: 'doc-1', inbox_item_id: 'item-1', fields: out as ReadingFields, door: { intake_source: 'upload', sender: null, received_at: null }, notes: [] }
}

const INVOICE_READING = reading({
  document_type: 'supplier_invoice',
  seller_name: 'Kontorsbolaget AB',
  amount_due_for_payment: 1250,
  invoice_currency_code: 'SEK',
  remittance_information: '4711000123',
  invoice_issue_date: '2026-09-01',
  payment_due_date: '2026-09-30',
})

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    status: 'received',
    source: 'upload',
    document_id: 'doc-1',
    extracted_data: READ,
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    email_from: null,
    email_received_at: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    routed_to_arkiv_at: null,
    created_at: '2026-09-02T08:00:00Z',
    bank_match_transaction_id: null,
    bank_match_basis: null,
    bank_match_evidence_level: null,
    bank_match_checked_at: null,
    bank_match_source_key: null,
    ...overrides,
  }
}

function bankRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    date: '2026-09-25',
    amount: -1250,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    description: 'Betalning',
    original_description: 'Betalning',
    merchant_name: null,
    reference: '4711000123',
    counterparty_account: null,
    journal_entry_id: null,
    is_ignored: false,
    invoice_id: null,
    supplier_invoice_id: null,
    receipt_id: null,
    document_id: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
    potential_journal_entry_id: null,
    potential_rot_rut_payout_request_id: null,
    potential_match_method: null,
    transaction_voucher_links: [],
    ...overrides,
  }
}

/** The item by id (`.maybeSingle()`), the open-item scan otherwise. */
function inboxItems(item: Record<string, unknown> | null, open: unknown[] = []): TableMockResolver {
  return (calls) => {
    if (calls.some((c) => c.method === 'update')) return { data: null }
    if (calls.some((c) => c.method === 'maybeSingle')) return { data: item }
    if (calls.some((c) => c.method === 'in')) return { data: [] }
    return { data: open }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  loadDocumentReading.mockResolvedValue(INVOICE_READING)
})

describe('refreshInboxItemBankMatch', () => {
  it('records the bank row that already paid the item as a proposal, with its basis and level', async () => {
    const { supabase, payloads, findCalls } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow()),
      transactions: [{ data: [bankRow()] }, { data: [] }],
    })
    const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)
    expect(outcome).toEqual({ status: 'updated', decision: { transactionId: 'tx-1', basis: 'rule_ocr_reference', evidenceLevel: 'exakt' } })
    const [write] = payloads('invoice_inbox_items', 'update') as Array<Record<string, unknown>>
    expect(write).toMatchObject({
      bank_match_transaction_id: 'tx-1',
      bank_match_basis: 'rule_ocr_reference',
      bank_match_evidence_level: 'exakt',
      bank_match_source_key: bankMatchCheckKey(itemRow()),
    })
    expect(typeof write.bank_match_checked_at).toBe('string')
    // Only while the item is still open, in this company.
    expect(findCalls('invoice_inbox_items', 'is')).toEqual(
      expect.arrayContaining([
        ['created_supplier_invoice_id', null],
        ['created_journal_entry_id', null],
        ['matched_transaction_id', null],
        ['routed_to_arkiv_at', null],
      ]),
    )
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('never writes a link or a booking: only the bank_match columns', async () => {
    const { supabase, payloads, tables } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow()),
      transactions: [{ data: [bankRow()] }, { data: [] }],
    })
    await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)
    for (const write of payloads('invoice_inbox_items', 'update') as Array<Record<string, unknown>>) {
      expect(Object.keys(write).every((key) => key.startsWith('bank_match_'))).toBe(true)
    }
    expect(payloads('transactions', 'update')).toEqual([])
    expect(tables()).not.toContain('journal_entries')
  })

  it('records "nothing found" once, and then writes nothing while the answer stands', async () => {
    const first = createTableMockSupabase({ invoice_inbox_items: inboxItems(itemRow()), transactions: { data: [] } })
    expect(await refreshInboxItemBankMatch(first.supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status: 'updated', decision: null })
    expect(first.payloads('invoice_inbox_items', 'update')[0]).toMatchObject({ bank_match_transaction_id: null, bank_match_basis: null })

    const checked = itemRow({ bank_match_checked_at: '2026-09-02T08:01:00Z', bank_match_source_key: bankMatchCheckKey(itemRow()) })
    const again = createTableMockSupabase({ invoice_inbox_items: inboxItems(checked), transactions: { data: [] } })
    expect(await refreshInboxItemBankMatch(again.supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status: 'unchanged', decision: null })
    expect(again.payloads('invoice_inbox_items', 'update')).toEqual([])
  })

  it('an answer older rules wrote is written again with the rules in force, the same answer or not', async () => {
    // The key a check stored before rules carried a version: the reading's fingerprint alone.
    const older = itemRow({ bank_match_checked_at: '2026-09-02T08:01:00Z', bank_match_source_key: bankMatchSourceKey(itemRow()) })
    const { supabase, payloads } = createTableMockSupabase({ invoice_inbox_items: inboxItems(older), transactions: { data: [] } })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status: 'updated', decision: null })
    expect(payloads('invoice_inbox_items', 'update')[0]).toMatchObject({ bank_match_source_key: bankMatchCheckKey(itemRow()) })
  })

  it('clears a proposal whose bank row is no longer free', async () => {
    const proposed = itemRow({
      bank_match_transaction_id: 'tx-1',
      bank_match_basis: 'rule_ocr_reference',
      bank_match_evidence_level: 'exakt',
      bank_match_checked_at: '2026-09-02T08:01:00Z',
      bank_match_source_key: bankMatchSourceKey(itemRow()),
    })
    const { supabase, payloads } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(proposed),
      transactions: [{ data: [bankRow({ journal_entry_id: 'je-1' })] }, { data: [] }],
    })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status: 'updated', decision: null })
    expect(payloads('invoice_inbox_items', 'update')[0]).toMatchObject({ bank_match_transaction_id: null })
  })

  it.each([
    ['closed', itemRow({ created_supplier_invoice_id: 'si-1' })],
    ['closed', itemRow({ matched_transaction_id: 'tx-9' })],
    ['pending', itemRow({ status: 'processing' })],
    ['not_found', null],
  ])('reads nothing more and writes nothing for an item that is %s', async (status, row) => {
    const { supabase, payloads, tables } = createTableMockSupabase({ invoice_inbox_items: inboxItems(row) })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status })
    expect(payloads('invoice_inbox_items', 'update')).toEqual([])
    expect(tables()).toEqual(['invoice_inbox_items'])
    expect(loadDocumentReading).not.toHaveBeenCalled()
  })

  describe('the card the purchase was paid with', () => {
    // The X subscription (prod, company Arcim): the invoice and its receipt came in one mail.
    const X_INVOICE_READ = {
      documentKind: 'supplier_invoice',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', dueDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
    }
    const X_RECEIPT_READ = {
      documentKind: 'receipt',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
      totals: { total: 83 },
      payment: { method: 'card', cardLast4: '3667' },
    }
    const X_READING = reading({
      document_type: 'supplier_invoice',
      seller_name: 'X Corp.',
      amount_due_for_payment: 83,
      invoice_currency_code: 'SEK',
      invoice_issue_date: '2026-10-03',
      payment_due_date: '2026-10-03',
    })
    const xInvoice = itemRow({ source: 'email', resend_email_id: 'mail-x', extracted_data: X_INVOICE_READ, created_at: '2026-10-03T08:00:00Z' })
    const xReceipt = { ...itemRow({ id: 'item-2', source: 'email', document_id: 'doc-2', resend_email_id: 'mail-x', extracted_data: X_RECEIPT_READ }) }
    const xRow = bankRow({ id: 'tx-x', date: '2026-10-05', amount: -83, reference: null, description: 'X CORP. PAID FEATURES K3667', original_description: null })

    /** The item by id, its mail's attachments by resend_email_id. */
    const mail = (item: Record<string, unknown>, siblings: unknown[]): TableMockResolver => (calls) => {
      if (calls.some((c) => c.method === 'update')) return { data: null }
      if (calls.some((c) => c.method === 'maybeSingle')) return { data: item }
      if (calls.some((c) => c.method === 'eq' && c.args[0] === 'resend_email_id')) return { data: siblings }
      return { data: [] }
    }

    beforeEach(() => {
      loadDocumentReading.mockResolvedValue(X_READING)
    })

    it('an invoice borrows the card of the receipt it came with: the row naming that card is stark', async () => {
      const { supabase, findCalls } = createTableMockSupabase({
        invoice_inbox_items: mail(xInvoice, [xInvoice, xReceipt]),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })
      expect(outcome).toEqual({ status: 'updated', decision: { transactionId: 'tx-x', basis: 'rule_amount_date', evidenceLevel: 'stark' } })
      // The mail's siblings, in this company.
      expect(findCalls('invoice_inbox_items', 'eq')).toEqual(expect.arrayContaining([['resend_email_id', 'mail-x'], ['company_id', COMPANY]]))
    })

    it('without the receipt the same row is trolig', async () => {
      const { supabase } = createTableMockSupabase({
        invoice_inbox_items: mail(xInvoice, [xInvoice]),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })
      expect(outcome).toMatchObject({ decision: { transactionId: 'tx-x', evidenceLevel: 'trolig' } })
    })

    it('a receipt from another mail lends no card', async () => {
      const { supabase } = createTableMockSupabase({
        invoice_inbox_items: mail(xInvoice, [xInvoice, { ...xReceipt, resend_email_id: 'another-mail' }]),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })
      expect(outcome).toMatchObject({ decision: { evidenceLevel: 'trolig' } })
    })

    it('a receipt reads its own card and needs no siblings', async () => {
      loadDocumentReading.mockResolvedValue(reading({ document_type: 'receipt', seller_name: 'X Corp.', amount_due_for_payment: 83, invoice_currency_code: 'SEK', invoice_issue_date: '2026-10-03' }))
      const { supabase, findCalls } = createTableMockSupabase({
        invoice_inbox_items: mail(xReceipt, []),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-2', RULES, { today: '2026-10-19' })
      expect(outcome).toMatchObject({ decision: { transactionId: 'tx-x', evidenceLevel: 'stark' } })
      expect(findCalls('invoice_inbox_items', 'eq')).not.toContainEqual(['resend_email_id', 'mail-x'])
    })

    it('the real seller name the bank text does not carry: the receipt\'s card alone makes it trolig', async () => {
      // As the production mail reads: "X Internet Unlimited Company" on both documents, "X CORP." on the bank row.
      const realName = { name: 'X Internet Unlimited Company' }
      const invoiceRead = { ...X_INVOICE_READ, supplier: realName }
      const receiptRead = { ...X_RECEIPT_READ, supplier: realName }
      loadDocumentReading.mockResolvedValue(reading({
        document_type: 'supplier_invoice',
        seller_name: 'X Internet Unlimited Company',
        amount_due_for_payment: 83,
        invoice_currency_code: 'SEK',
        invoice_issue_date: '2026-10-03',
        payment_due_date: '2026-10-03',
      }))
      const realInvoice = { ...xInvoice, extracted_data: invoiceRead }
      const realReceipt = { ...xReceipt, extracted_data: receiptRead }
      const paired = createTableMockSupabase({
        invoice_inbox_items: mail(realInvoice, [realInvoice, realReceipt]),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      expect(await refreshInboxItemBankMatch(paired.supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })).toEqual({
        status: 'updated',
        decision: { transactionId: 'tx-x', basis: 'rule_amount_date', evidenceLevel: 'trolig' },
      })
      // Without the receipt there is no card, and the name does not agree: nothing.
      const alone = createTableMockSupabase({
        invoice_inbox_items: mail(realInvoice, [realInvoice]),
        transactions: [{ data: [xRow] }, { data: [] }],
      })
      expect(await refreshInboxItemBankMatch(alone.supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })).toMatchObject({ decision: null })
    })

    it('a sibling read that fails leaves the card out, never the check', async () => {
      const failing: TableMockResolver = (calls) => {
        if (calls.some((c) => c.method === 'update')) return { data: null }
        if (calls.some((c) => c.method === 'maybeSingle')) return { data: xInvoice }
        if (calls.some((c) => c.method === 'eq' && c.args[0] === 'resend_email_id')) return { data: null, error: { message: 'boom' } }
        return { data: [] }
      }
      const { supabase } = createTableMockSupabase({ invoice_inbox_items: failing, transactions: [{ data: [xRow] }, { data: [] }] })
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, { today: '2026-10-19' })
      expect(outcome).toMatchObject({ decision: { evidenceLevel: 'trolig' } })
    })
  })

  it('a document the matcher does not pay (a government letter) gets an empty answer and no bank read', async () => {
    loadDocumentReading.mockResolvedValue(reading({ document_type: 'government_letter', amount_due_for_payment: 1250 }))
    const { supabase, tables } = createTableMockSupabase({ invoice_inbox_items: inboxItems(itemRow()) })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)).toEqual({ status: 'updated', decision: null })
    expect(tables()).not.toContain('transactions')
  })

  it('reads the supplier card for its giro and name', async () => {
    loadDocumentReading.mockResolvedValue(
      reading({ document_type: 'supplier_invoice', seller_name: 'Okänd', amount_due_for_payment: 1250, invoice_issue_date: '2026-09-01', payment_due_date: '2026-09-30' }),
    )
    const { supabase } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow({ matched_supplier_id: 'supplier-1' })),
      suppliers: { data: { name: 'Kontorsbolaget AB', bankgiro: '999-0003', plusgiro: null } },
      transactions: [{ data: [bankRow({ reference: null, counterparty_account: '999-0003' })] }, { data: [] }],
    })
    const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)
    expect(outcome).toEqual({ status: 'updated', decision: { transactionId: 'tx-1', basis: 'rule_counterparty', evidenceLevel: 'stark' } })
  })

  it('a foreign document asks Riksbanken for its kronor value on the issue date', async () => {
    loadDocumentReading.mockResolvedValue(
      reading({ document_type: 'receipt', seller_name: 'OpenAI, LLC', amount_due_for_payment: 20, invoice_currency_code: 'USD', invoice_issue_date: '2026-09-10' }),
    )
    const { supabase } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow()),
      transactions: [{ data: [] }, { data: [bankRow({ amount: -215, reference: null, merchant_name: 'OPENAI', date: '2026-09-11' })] }],
    })
    const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)
    expect(DEPS.rateFor).toHaveBeenCalledWith('USD', '2026-09-10')
    expect(outcome).toMatchObject({ decision: { evidenceLevel: 'trolig', basis: 'rule_amount_date' } })
  })

  it('a document in a currency Riksbanken has no rate for (Albanian lek) is checked without a kronor value: no proposal, no request, no error', async () => {
    loadDocumentReading.mockResolvedValue(
      reading({ document_type: 'receipt', seller_name: 'Hotel Vlora', amount_due_for_payment: 7000, invoice_currency_code: 'ALL', invoice_issue_date: '2026-08-23' }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow()),
      transactions: [{ data: [] }, { data: [bankRow({ amount: -700, reference: null, merchant_name: 'HOTEL VLORA', date: '2026-08-23' })] }],
    })
    try {
      // The default rate lookup (Riksbanken through fetchExchangeRate), not an injected one.
      const outcome = await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, { today: DEPS.today })
      expect(outcome).toEqual({ status: 'updated', decision: null })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('throws on a failed read, leaving the stored answer as it was', async () => {
    const { supabase, payloads } = createTableMockSupabase({ invoice_inbox_items: { error: { message: 'boom' } } })
    await expect(refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, DEPS)).rejects.toThrow('boom')
    expect(payloads('invoice_inbox_items', 'update')).toEqual([])
  })
})

describe('refreshInboxItemBankMatch: a late payment and the other open items', () => {
  // The same amount to the same giro every month: September's invoice (item-1) and October's (item-2).
  const giroReading = (issue: string, due: string) =>
    reading({
      document_type: 'supplier_invoice',
      seller_name: 'Kontorsbolaget AB',
      amount_due_for_payment: 1250,
      invoice_currency_code: 'SEK',
      payment_account_bankgiro: '999-0003',
      invoice_issue_date: issue,
      payment_due_date: due,
    })
  const SEPTEMBER = giroReading('2026-09-01', '2026-09-30')
  const OCTOBER = giroReading('2026-10-01', '2026-10-31')
  const september = itemRow()
  const october = itemRow({
    id: 'item-2',
    document_id: 'doc-2',
    created_at: '2026-10-02T08:00:00Z',
    extracted_data: { ...READ, invoice: { ...READ.invoice, invoiceDate: '2026-10-01', dueDate: '2026-10-31', paymentReference: null } },
  })
  const TODAY = { today: '2026-10-28' }
  // Paid on 2026-10-25: inside October's window, 25 days after September's due date.
  const paid = bankRow({ id: 'tx-paid', date: '2026-10-25', reference: null, counterparty_account: '999-0003' })
  /** The same-currency read answers the row, the foreign-currency read nothing. */
  const bank: TableMockResolver = (calls) => (calls.some((c) => c.method === 'neq') ? { data: [] } : { data: [paid] })

  /** Items by id, the open queue, and the items whose standing proposal names a row. */
  function inbox(byId: Record<string, Record<string, unknown>>, open: unknown[], proposers: string[] = []): TableMockResolver {
    return (calls) => {
      if (calls.some((c) => c.method === 'update')) return { data: null }
      if (calls.some((c) => c.method === 'maybeSingle')) {
        const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
        return { data: byId[id] ?? null }
      }
      if (calls.some((c) => c.method === 'in' && c.args[0] === 'bank_match_transaction_id')) return { data: proposers.map((id) => ({ id })) }
      if (calls.some((c) => c.method === 'in')) return { data: [] }
      return { data: open }
    }
  }

  beforeEach(() => {
    loadDocumentReading.mockImplementation(async (_s: unknown, _c: unknown, target: { item: { id: string } }) =>
      target.item.id === 'item-2' ? OCTOBER : SEPTEMBER,
    )
  })

  it('late and alone: the payee giro proposes it, stark', async () => {
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-1': september }, [september]), transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, TODAY)).toEqual({
      status: 'updated',
      decision: { transactionId: 'tx-paid', basis: 'rule_counterparty', evidenceLevel: 'stark' },
    })
  })

  it('this month\'s item, read as it reads itself, holds the row: last month\'s late claim gives it up', async () => {
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-1': september }, [september, october]), transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, TODAY)).toEqual({ status: 'updated', decision: null })
    // The rival was read through the same reading as the item itself.
    expect(loadDocumentReading).toHaveBeenCalledWith(supabase, COMPANY, { item: october }, undefined)
  })

  it('rivals are read only when a late claim could be proposed', async () => {
    const onTime = bankRow({ id: 'tx-on-time', date: '2026-09-28', reference: null, counterparty_account: '999-0003' })
    const { supabase, findCalls } = createTableMockSupabase({
      invoice_inbox_items: inbox({ 'item-1': september }, [september, october]),
      transactions: (calls) => (calls.some((c) => c.method === 'neq') ? { data: [] } : { data: [onTime, paid] }),
    })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, TODAY)).toMatchObject({ decision: { transactionId: 'tx-on-time' } })
    expect(loadDocumentReading).toHaveBeenCalledTimes(1)
    // No read of the open queue.
    expect(findCalls('invoice_inbox_items', 'limit')).not.toContainEqual([OPEN_ITEMS_SCANNED])
  })

  it('more open items with the amount than can be weighed: no late claim', async () => {
    const many = Array.from({ length: RIVALS_READ + 1 }, (_, i) => ({ ...october, id: `other-${i}` }))
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-1': september }, [september, ...many]), transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, TODAY)).toEqual({ status: 'updated', decision: null })
    expect(loadDocumentReading).toHaveBeenCalledTimes(1)
  })

  it('a rival that cannot be read: no late claim, and the check itself still answers', async () => {
    loadDocumentReading.mockImplementation(async (_s: unknown, _c: unknown, target: { item: { id: string } }) => {
      if (target.item.id === 'item-2') throw new Error('unreadable')
      return SEPTEMBER
    })
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-1': september }, [september, october]), transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-1', RULES, TODAY)).toEqual({ status: 'updated', decision: null })
  })

  it('an item that arrives later and holds a row better: the other item\'s standing late claim is looked at again, once', async () => {
    // September proposed the row while October was not yet in the inbox.
    const proposed = itemRow({
      bank_match_transaction_id: 'tx-paid',
      bank_match_basis: 'rule_counterparty',
      bank_match_evidence_level: 'stark',
      bank_match_checked_at: '2026-10-26T08:00:00Z',
      bank_match_source_key: bankMatchCheckKey(september),
    })
    const { supabase, payloads, findCalls } = createTableMockSupabase({
      invoice_inbox_items: inbox({ 'item-1': proposed, 'item-2': october }, [proposed, october], ['item-1']),
      transactions: bank,
    })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-2', RULES, TODAY)).toEqual({
      status: 'updated',
      decision: { transactionId: 'tx-paid', basis: 'rule_counterparty', evidenceLevel: 'stark' },
      others: { checked: 1, failed: 0 },
    })
    // October's answer, then September's withdrawn: the row is October's.
    expect(payloads('invoice_inbox_items', 'update')).toEqual([
      expect.objectContaining({ bank_match_transaction_id: 'tx-paid' }),
      expect.objectContaining({ bank_match_transaction_id: null, bank_match_source_key: bankMatchCheckKey(september) }),
    ])
    // The others asked for are the open ones proposing a row October could claim, never October itself.
    expect(findCalls('invoice_inbox_items', 'in')).toContainEqual(['bank_match_transaction_id', ['tx-paid']])
    expect(findCalls('invoice_inbox_items', 'neq')).toContainEqual(['id', 'item-2'])
    // September's look goes no further: one ask for others in all.
    expect(findCalls('invoice_inbox_items', 'in').filter(([column]) => column === 'bank_match_transaction_id')).toHaveLength(1)
  })

  it('nothing to look at again when the answer stands, or the item could claim no row', async () => {
    const standing = { ...october, bank_match_checked_at: '2026-10-26T08:00:00Z', bank_match_source_key: bankMatchCheckKey(october), bank_match_transaction_id: 'tx-paid', bank_match_basis: 'rule_counterparty', bank_match_evidence_level: 'stark' }
    const stands = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-2': standing }, [september, standing], ['item-1']), transactions: bank })
    expect(await refreshInboxItemBankMatch(stands.supabase as never, COMPANY, 'item-2', RULES, TODAY)).toMatchObject({ status: 'unchanged' })
    expect(stands.findCalls('invoice_inbox_items', 'in')).not.toContainEqual(['bank_match_transaction_id', ['tx-paid']])

    const none = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-2': october }, [september, october], ['item-1']), transactions: { data: [] } })
    expect(await refreshInboxItemBankMatch(none.supabase as never, COMPANY, 'item-2', RULES, TODAY)).toEqual({ status: 'updated', decision: null })
    expect(none.payloads('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('a look at the others that fails is counted, never thrown: the item\'s own answer is written', async () => {
    const failing: TableMockResolver = (calls) => {
      if (calls.some((c) => c.method === 'in' && c.args[0] === 'bank_match_transaction_id')) return { data: null, error: { message: 'boom' } }
      return inbox({ 'item-2': october }, [october])(calls)
    }
    const { supabase, payloads } = createTableMockSupabase({ invoice_inbox_items: failing, transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-2', RULES, TODAY)).toMatchObject({
      status: 'updated',
      decision: { transactionId: 'tx-paid' },
      others: { checked: 0, failed: 1 },
    })
    expect(payloads('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('without recheckOthers, the check looks no further', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ invoice_inbox_items: inbox({ 'item-2': october }, [october], ['item-1']), transactions: bank })
    expect(await refreshInboxItemBankMatch(supabase as never, COMPANY, 'item-2', RULES, { ...TODAY, recheckOthers: false })).toEqual({
      status: 'updated',
      decision: { transactionId: 'tx-paid', basis: 'rule_counterparty', evidenceLevel: 'stark' },
    })
    expect(findCalls('invoice_inbox_items', 'in')).not.toContainEqual(['bank_match_transaction_id', ['tx-paid']])
  })

  it('a bank arrival reads the open queue once: each check weighs its rivals from it and looks no further', async () => {
    const arrived = [{ id: 'tx-paid', company_id: COMPANY, amount: -1250, currency: 'SEK', journal_entry_id: null, is_ignored: false }]
    const { supabase, findCalls } = createTableMockSupabase({
      invoice_inbox_items: inbox({ 'item-1': september, 'item-2': october }, [october, september], ['item-1']),
      transactions: bank,
    })
    expect(await refreshInboxBankMatchesForTransactions(supabase as never, COMPANY, arrived, RULES, TODAY)).toEqual({ items_checked: 2, failed: 0 })
    // One read of the open queue, none of the others' proposals.
    expect(findCalls('invoice_inbox_items', 'limit')).toEqual([[OPEN_ITEMS_SCANNED]])
    expect(findCalls('invoice_inbox_items', 'in').filter(([column]) => column === 'bank_match_transaction_id')).toEqual([])
  })
})

describe('mayBePaidBy', () => {
  it('the same amount in the same currency, whatever the sign', () => {
    expect(mayBePaidBy(READ, [{ id: 'a', amount: -1250, currency: 'SEK' }])).toBe(true)
    expect(mayBePaidBy(READ, [{ id: 'a', amount: -1251, currency: 'SEK' }])).toBe(false)
  })

  it('another currency: a row that names the supplier', () => {
    expect(mayBePaidBy(READ, [{ id: 'a', amount: -110, currency: 'EUR', merchant_name: 'KONTORSBOLAGET' }])).toBe(true)
    expect(mayBePaidBy(READ, [{ id: 'a', amount: -110, currency: 'EUR', merchant_name: 'IKEA' }])).toBe(false)
  })

  it('nothing without a total', () => {
    expect(mayBePaidBy({ ...READ, totals: {} }, [{ id: 'a', amount: -1250, currency: 'SEK' }])).toBe(false)
    expect(mayBePaidBy(null, [{ id: 'a', amount: -1250, currency: 'SEK' }])).toBe(false)
  })
})

describe('refreshInboxBankMatchesForTransactions', () => {
  const arrived = [{ id: 'tx-1', company_id: COMPANY, amount: -1250, currency: 'SEK', journal_entry_id: null, is_ignored: false }]

  it('looks again only at the open items a new row could pay', async () => {
    const open = [
      { id: 'item-1', extracted_data: READ },
      { id: 'item-2', extracted_data: { ...READ, totals: { total: 99 } } },
    ]
    const { supabase, findCalls } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow(), open),
      transactions: [{ data: [bankRow()] }, { data: [] }],
    })
    expect(await refreshInboxBankMatchesForTransactions(supabase as never, COMPANY, arrived, RULES, DEPS)).toEqual({ items_checked: 1, failed: 0 })
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['id', 'item-1'])
    expect(findCalls('invoice_inbox_items', 'eq')).not.toContainEqual(['id', 'item-2'])
    // The scan reads the open queue of this company only.
    expect(findCalls('invoice_inbox_items', 'is')).toContainEqual(['routed_to_arkiv_at', null])
  })

  it('skips booked, ignored and other companies\' rows without reading the inbox', async () => {
    const { supabase, tables } = createTableMockSupabase()
    const rows = [
      { ...arrived[0], journal_entry_id: 'je-1' },
      { ...arrived[0], id: 'tx-2', is_ignored: true },
      { ...arrived[0], id: 'tx-3', company_id: 'company-2' },
      { ...arrived[0], id: 'tx-4', amount: 0 },
    ]
    expect(await refreshInboxBankMatchesForTransactions(supabase as never, COMPANY, rows, RULES, DEPS)).toEqual({ items_checked: 0, failed: 0 })
    expect(tables()).toEqual([])
  })

  it('caps the items looked at per arrival, and one failing item does not stop the rest', async () => {
    const open = Array.from({ length: ITEMS_REFRESHED_PER_ARRIVAL + 5 }, (_, i) => ({ id: `item-${i}`, extracted_data: READ }))
    loadDocumentReading.mockRejectedValueOnce(new Error('unreadable'))
    const { supabase } = createTableMockSupabase({
      invoice_inbox_items: inboxItems(itemRow(), open),
      transactions: { data: [] },
    })
    expect(await refreshInboxBankMatchesForTransactions(supabase as never, COMPANY, arrived, RULES, DEPS)).toEqual({
      items_checked: ITEMS_REFRESHED_PER_ARRIVAL,
      failed: 1,
    })
  })
})
