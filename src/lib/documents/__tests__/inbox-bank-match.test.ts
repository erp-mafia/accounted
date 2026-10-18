import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  BankMatchSchema,
  bankMatchLinkEvidence,
  bankMatchSourceKey,
  readInboxBankMatch,
  readInboxBankMatches,
  searchProposableBankRows,
  storedBankMatch,
  type BankMatchItemRow,
  type BankRowSearch,
} from '../inbox-bank-match'

const COMPANY = 'company-1'

const READ = {
  supplier: { name: 'Kontorsbolaget AB', bankgiro: '999-0003', plusgiro: null },
  invoice: { invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'SEK', paymentReference: '4711000123' },
  totals: { total: 1250, subtotal: 1000, vatAmount: 250 },
  documentKind: 'supplier_invoice',
}

function item(overrides: Partial<BankMatchItemRow> = {}): BankMatchItemRow {
  const base: BankMatchItemRow = {
    id: 'item-1',
    document_id: 'doc-1',
    extracted_data: READ,
    kind_hint: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    routed_to_arkiv_at: null,
    bank_match_transaction_id: 'tx-1',
    bank_match_basis: 'rule_ocr_reference',
    bank_match_evidence_level: 'exakt',
    ...overrides,
  }
  return { ...base, bank_match_source_key: overrides.bank_match_source_key ?? bankMatchSourceKey(base) }
}

function bankRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    date: '2026-09-25',
    amount: -1250,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    description: 'Betalning OCR',
    original_description: 'Betalning OCR',
    merchant_name: 'KONTORSBOLAGET',
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

describe('bankMatchSourceKey', () => {
  it('is the same for the same reading, whatever the key order', () => {
    const reordered = { documentKind: 'supplier_invoice', totals: { vatAmount: 250, total: 1250, subtotal: 1000 }, invoice: READ.invoice, supplier: READ.supplier }
    expect(bankMatchSourceKey(item({ extracted_data: reordered }))).toBe(bankMatchSourceKey(item()))
  })

  it('ignores what the matcher never reads: a purchase category, the lines', () => {
    const categorised = { ...READ, purchaseCategory: { code: 'expense.office.supplies', source: 'person' }, lineItems: [{ description: 'Papper' }] }
    expect(bankMatchSourceKey(item({ extracted_data: categorised }))).toBe(bankMatchSourceKey(item()))
  })

  it('changes with the amount, the OCR, the supplier or the declared kind', () => {
    const key = bankMatchSourceKey(item())
    expect(bankMatchSourceKey(item({ extracted_data: { ...READ, totals: { ...READ.totals, total: 1000 } } }))).not.toBe(key)
    expect(bankMatchSourceKey(item({ extracted_data: { ...READ, invoice: { ...READ.invoice, paymentReference: '1' } } }))).not.toBe(key)
    expect(bankMatchSourceKey(item({ matched_supplier_id: 'supplier-2' }))).not.toBe(key)
    expect(bankMatchSourceKey(item({ kind_hint: 'receipt' }))).not.toBe(key)
  })
})

describe('storedBankMatch', () => {
  it('reads the proposal of an open item that still reads the same', () => {
    expect(storedBankMatch(item())).toEqual({ transactionId: 'tx-1', basis: 'rule_ocr_reference', evidenceLevel: 'exakt' })
  })

  it.each([
    ['converted to a supplier invoice', { created_supplier_invoice_id: 'si-1' }],
    ['booked', { created_journal_entry_id: 'je-1' }],
    ['paired with a bank row', { matched_transaction_id: 'tx-9' }],
    ['moved to Arkiv', { routed_to_arkiv_at: '2026-09-03T10:00:00Z' }],
    ['without a proposal', { bank_match_transaction_id: null }],
    ['with a basis outside the vocabulary', { bank_match_basis: 'user_confirmed' }],
    ['with a level outside the vocabulary', { bank_match_evidence_level: 'ditt_val' }],
    ['whose reading changed since', { bank_match_source_key: 'v1:00000000' }],
  ])('none for an item %s', (_label, overrides) => {
    expect(storedBankMatch(item(overrides as Partial<BankMatchItemRow>))).toBeNull()
  })
})

describe('bankMatchLinkEvidence', () => {
  it('names the rule when the booked bank row is the proposed one', () => {
    expect(bankMatchLinkEvidence(item(), 'tx-1')).toEqual({ rule_id: 'inbox_bank_match:rule_ocr_reference' })
  })

  it('nothing for another bank row, or without a proposal', () => {
    expect(bankMatchLinkEvidence(item(), 'tx-2')).toBeUndefined()
    expect(bankMatchLinkEvidence(item(), null)).toBeUndefined()
    expect(bankMatchLinkEvidence(item({ bank_match_transaction_id: null }), 'tx-1')).toBeUndefined()
  })
})

describe('readInboxBankMatch', () => {
  it('answers the proposal with the bank row as it stands', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { data: bankRow() } })
    const match = await readInboxBankMatch(supabase as never, COMPANY, item())
    expect(match).toEqual({
      transaction_id: 'tx-1',
      date: '2026-09-25',
      amount: -1250,
      currency: 'SEK',
      counterparty: 'KONTORSBOLAGET',
      basis: 'rule_ocr_reference',
      evidence_level: 'exakt',
    })
    expect(BankMatchSchema.safeParse({ ...match, transaction_id: '6f1d2b1e-4f9c-4b8e-9a3c-2f1d0e9c8b7a' }).success).toBe(true)
  })

  it('reads nothing for an item without a standing proposal', async () => {
    const { supabase, tables } = createTableMockSupabase()
    expect(await readInboxBankMatch(supabase as never, COMPANY, item({ created_journal_entry_id: 'je-1' }))).toBeNull()
    expect(tables()).toEqual([])
  })

  it.each([
    ['booked since', { journal_entry_id: 'je-1' }],
    ['booked into a samlingsverifikat', { transaction_voucher_links: [{ journal_entry_id: 'je-1', role: 'bank_line' }] }],
    ['ignored', { is_ignored: true }],
    ['suggested for a registered supplier invoice by the bank feed', { potential_supplier_invoice_id: 'si-1' }],
    ['matched to a verifikat by reconciliation', { potential_journal_entry_id: 'je-2' }],
    ['carrying another document', { document_id: 'doc-other' }],
  ])('none when the bank row is %s', async (_label, overrides) => {
    const { supabase } = createTableMockSupabase({ transactions: { data: bankRow(overrides) } })
    expect(await readInboxBankMatch(supabase as never, COMPANY, item())).toBeNull()
  })

  it('keeps the proposal when the row carries this item\'s own document', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { data: bankRow({ document_id: 'doc-1' }) } })
    expect(await readInboxBankMatch(supabase as never, COMPANY, item())).not.toBeNull()
  })

  it.each([
    ['a supplier payment row', { supplier_invoice_payments: { data: [{ transaction_id: 'tx-1' }] } }],
    ['a customer payment row', { invoice_payments: { data: [{ transaction_id: 'tx-1' }] } }],
    ['another inbox item paired with it', { invoice_inbox_items: { data: [{ id: 'item-2', matched_transaction_id: 'tx-1' }] } }],
  ])('none when %s claims the bank row', async (_label, tables) => {
    const { supabase } = createTableMockSupabase({ transactions: { data: bankRow() }, ...tables })
    expect(await readInboxBankMatch(supabase as never, COMPANY, item())).toBeNull()
  })

  it('none when the bank row is gone', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { data: null } })
    expect(await readInboxBankMatch(supabase as never, COMPANY, item())).toBeNull()
  })

  it('throws on a failed read, for the caller to answer null', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { error: { message: 'timeout' } } })
    await expect(readInboxBankMatch(supabase as never, COMPANY, item())).rejects.toThrow('timeout')
  })

  it('scopes every read to the company', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: { data: bankRow() } })
    await readInboxBankMatch(supabase as never, COMPANY, item())
    for (const table of ['transactions', 'invoice_payments', 'supplier_invoice_payments', 'invoice_inbox_items']) {
      expect(findCalls(table, 'eq'), table).toContainEqual(['company_id', COMPANY])
    }
  })
})

describe('readInboxBankMatches', () => {
  // Three open items with a proposal each (tx-1, tx-2, tx-3), one closed, one without.
  const items = () => [
    item({ id: 'item-1', bank_match_transaction_id: 'tx-1' }),
    item({ id: 'item-2', document_id: 'doc-2', bank_match_transaction_id: 'tx-2' }),
    item({ id: 'item-3', document_id: 'doc-3', bank_match_transaction_id: 'tx-3' }),
    item({ id: 'booked', bank_match_transaction_id: 'tx-4', created_journal_entry_id: 'je-1' }),
    item({ id: 'none', bank_match_transaction_id: null }),
  ]

  it('answers every standing proposal of the list, in one read per table however long it is', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      transactions: { data: [bankRow({ id: 'tx-1' }), bankRow({ id: 'tx-2', date: '2026-09-26' }), bankRow({ id: 'tx-3' })] },
    })
    const matches = await readInboxBankMatches(supabase as never, COMPANY, items())
    expect([...matches.keys()].sort()).toEqual(['item-1', 'item-2', 'item-3'])
    expect(matches.get('item-2')).toMatchObject({ transaction_id: 'tx-2', date: '2026-09-26', basis: 'rule_ocr_reference', evidence_level: 'exakt' })
    // The proposed rows together, not one read per item; the closed item's row is never asked for.
    expect(findCalls('transactions', 'select')).toHaveLength(1)
    expect(findCalls('transactions', 'in')).toEqual([['id', ['tx-1', 'tx-2', 'tx-3']]])
    for (const table of ['invoice_payments', 'supplier_invoice_payments', 'invoice_inbox_items']) {
      expect(findCalls(table, 'select'), table).toHaveLength(1)
    }
  })

  it('reads nothing when no item has a standing proposal', async () => {
    const { supabase, tables } = createTableMockSupabase()
    expect((await readInboxBankMatches(supabase as never, COMPANY, [item({ bank_match_transaction_id: null })])).size).toBe(0)
    expect(await readInboxBankMatches(supabase as never, COMPANY, [])).toEqual(new Map())
    expect(tables()).toEqual([])
  })

  it('leaves out an item whose row was booked, claimed or is gone, and keeps the rest', async () => {
    const { supabase } = createTableMockSupabase({
      // tx-3 is gone.
      transactions: { data: [bankRow({ id: 'tx-1', journal_entry_id: 'je-9' }), bankRow({ id: 'tx-2' })] },
      supplier_invoice_payments: { data: [] },
      invoice_inbox_items: { data: [] },
    })
    const matches = await readInboxBankMatches(supabase as never, COMPANY, items())
    expect([...matches.keys()]).toEqual(['item-2'])
  })

  it('leaves out an item whose row another inbox item is paired with, or a payment books', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: [bankRow({ id: 'tx-1' }), bankRow({ id: 'tx-2' }), bankRow({ id: 'tx-3' })] },
      invoice_payments: { data: [{ transaction_id: 'tx-3' }] },
      invoice_inbox_items: { data: [{ id: 'item-9', matched_transaction_id: 'tx-1' }] },
    })
    const matches = await readInboxBankMatches(supabase as never, COMPANY, items())
    expect([...matches.keys()]).toEqual(['item-2'])
  })

  it('leaves out an item that no longer reads as it did when the proposal was written', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { data: [bankRow({ id: 'tx-1' })] } })
    const stale = { ...item({ id: 'item-1', bank_match_transaction_id: 'tx-1' }), extracted_data: { ...READ, totals: { total: 990 } } }
    expect((await readInboxBankMatches(supabase as never, COMPANY, [stale])).size).toBe(0)
  })

  it('throws on a failed read, for the list to answer without proposals', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { error: { message: 'timeout' } } })
    await expect(readInboxBankMatches(supabase as never, COMPANY, items())).rejects.toThrow('timeout')
  })

  it('scopes every read to the company', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: { data: [bankRow({ id: 'tx-1' })] } })
    await readInboxBankMatches(supabase as never, COMPANY, items())
    for (const table of ['transactions', 'invoice_payments', 'supplier_invoice_payments', 'invoice_inbox_items']) {
      expect(findCalls(table, 'eq'), table).toContainEqual(['company_id', COMPANY])
    }
  })
})

describe('searchProposableBankRows', () => {
  const search = (overrides: Partial<BankRowSearch> = {}): BankRowSearch => ({
    inboxItemId: 'item-1',
    documentId: 'doc-1',
    direction: 'out',
    from: '2026-07-03',
    to: '2026-11-29',
    currency: 'SEK',
    amount: 1250,
    amountSek: 1250,
    convertedTolerance: 0.09,
    ...overrides,
  })

  it('reads debits within a hair of the amount, in kronor, in the window', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: [{ data: [bankRow()] }, { data: [] }] })
    const rows = await searchProposableBankRows(supabase as never, COMPANY, search())
    expect(rows.map((r) => r.id)).toEqual(['tx-1'])
    expect(findCalls('transactions', 'gte')).toContainEqual(['amount', -1250.01])
    expect(findCalls('transactions', 'lte')).toContainEqual(['amount', -1249.99])
    expect(findCalls('transactions', 'gte')).toContainEqual(['date', '2026-07-03'])
    expect(findCalls('transactions', 'or')).toContainEqual(['currency.is.null,currency.eq.SEK'])
    expect(findCalls('transactions', 'is')).toContainEqual(['journal_entry_id', null])
  })

  it('reads credits for money coming back', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: [{ data: [] }, { data: [] }] })
    await searchProposableBankRows(supabase as never, COMPANY, search({ direction: 'in' }))
    expect(findCalls('transactions', 'gte')).toContainEqual(['amount', 1249.99])
  })

  it('a kronor document also reads rows in another currency, kept by their kronor value', async () => {
    const eur = bankRow({ id: 'tx-eur', currency: 'EUR', amount: -110, amount_sek: -1260 })
    const farEur = bankRow({ id: 'tx-far', currency: 'EUR', amount: -200, amount_sek: -2300 })
    const credit = bankRow({ id: 'tx-in', currency: 'EUR', amount: 110, amount_sek: 1260 })
    const { supabase } = createTableMockSupabase({ transactions: [{ data: [] }, { data: [eur, farEur, credit] }] })
    const rows = await searchProposableBankRows(supabase as never, COMPANY, search())
    expect(rows.map((r) => r.id)).toEqual(['tx-eur'])
  })

  it('a foreign document reads kronor rows by its kronor value', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: [{ data: [] }, { data: [bankRow({ id: 'tx-sek', amount: -215 })] }] })
    const rows = await searchProposableBankRows(supabase as never, COMPANY, search({ currency: 'USD', amount: 20, amountSek: 210 }))
    expect(rows.map((r) => r.id)).toEqual(['tx-sek'])
    expect(findCalls('transactions', 'eq')).toContainEqual(['currency', 'USD'])
  })

  it('without a kronor value reads the document\'s own currency only', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ transactions: { data: [] } })
    await searchProposableBankRows(supabase as never, COMPANY, search({ currency: 'USD', amount: 20, amountSek: null }))
    expect(findCalls('transactions', 'select')).toHaveLength(1)
  })

  it('drops rows something else claims, once each', async () => {
    const rows = [bankRow({ id: 'tx-free' }), bankRow({ id: 'tx-free' }), bankRow({ id: 'tx-booked', transaction_voucher_links: [{ journal_entry_id: 'je-1', role: 'bank_line' }] }), bankRow({ id: 'tx-paid' })]
    const { supabase } = createTableMockSupabase({
      transactions: [{ data: rows }, { data: [] }],
      supplier_invoice_payments: { data: [{ transaction_id: 'tx-paid' }] },
    })
    expect((await searchProposableBankRows(supabase as never, COMPANY, search())).map((r) => r.id)).toEqual(['tx-free'])
  })

  it('a row paired with this very item stays', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: [{ data: [bankRow()] }, { data: [] }],
      invoice_inbox_items: { data: [{ id: 'item-1', matched_transaction_id: 'tx-1' }] },
    })
    expect(await searchProposableBankRows(supabase as never, COMPANY, search())).toHaveLength(1)
  })
})
