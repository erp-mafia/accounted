import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  documentLedgerLinks,
  invoiceLinks,
  readSkattekontoRow,
  RECORD_LINK_LIMIT,
  supplierInvoiceLinks,
  transactionLinks,
  verifikatBookedRecords,
  type TransactionLinkInput,
} from '../record-links'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TX = '11111111-1111-4111-8111-111111111111'
const SI = '22222222-2222-4222-8222-222222222222'
const INV = '33333333-3333-4333-8333-333333333333'
const CN = '44444444-4444-4444-8444-444444444444'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const JE2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SKV = '55555555-5555-4555-8555-555555555555'
const OP = '66666666-6666-4666-8666-666666666666'

const mock = createQueuedMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient

beforeEach(() => mock.reset())

/** Every query of a reader filters by the company and is bounded. */
function expectCompanyScopedAndBounded(tables: string[]) {
  for (const table of tables) {
    expect(mock.findCalls(table, 'eq'), table).toEqual(expect.arrayContaining([['company_id', CO]]))
  }
}

const bankRow = (over: Partial<TransactionLinkInput> = {}): TransactionLinkInput => ({
  transaction_id: TX,
  journal_entry_id: null,
  invoice_id: null,
  supplier_invoice_id: null,
  potential_invoice_id: null,
  potential_supplier_invoice_id: null,
  potential_journal_entry_id: null,
  potential_match_confidence: null,
  documents: [],
  ...over,
})

describe('transactionLinks', () => {
  it('names each verifikat, payment and underlag with its basis and amount, and the suggestion apart', async () => {
    mock.enqueue({ data: [{ link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'auto_reference', reference: '4471' } }] }) // pointer basis
    mock.enqueue({ data: [{ journal_entry_id: JE2, allocated_amount: '600.50', role: 'bank_line', link_basis: null, link_evidence: null }] })
    mock.enqueue({ data: [{ id: 'ip-1', invoice_id: INV, amount: '400', currency: 'SEK', payment_date: '2026-10-28', journal_entry_id: JE, link_basis: 'user_confirmed', link_evidence: null }] })
    mock.enqueue({ data: [] }) // no supplier payments
    mock.enqueue({ data: [{ id: DOC, link_basis: 'user_created', link_evidence: null }] }) // document basis
    const links = await transactionLinks(
      supabase,
      CO,
      bankRow({
        journal_entry_id: JE,
        invoice_id: INV, // the same tie as the payment row: said once, with the amount
        potential_supplier_invoice_id: SI,
        potential_match_confidence: 0.97,
        documents: [{ document_id: DOC, journal_entry_id: JE, pinned_to_transaction: false }],
      }),
    )
    expect(links).toEqual([
      { relation: 'booked_by', record_ref: `journal_entry:${JE}`, basis: 'rule_ocr_reference', evidence: { rule_id: 'auto_reference', reference: '4471' }, via: 'pointer' },
      { relation: 'booked_by', record_ref: `journal_entry:${JE2}`, basis: null, via: 'bank_line', amount: 600.5 },
      { relation: 'pays', record_ref: `invoice:${INV}`, basis: 'user_confirmed', amount: 400, currency: 'SEK', date: '2026-10-28', journal_entry_id: JE, invoice_payment_id: 'ip-1' },
      { relation: 'underlag', record_ref: `document:${DOC}`, basis: 'user_created', via: 'verifikat', journal_entry_id: JE },
      { relation: 'suggested_match', record_ref: `supplier_invoice:${SI}`, basis: null, confidence: 0.97 },
    ])
    expectCompanyScopedAndBounded(['transactions', 'transaction_voucher_links', 'invoice_payments', 'supplier_invoice_payments', 'document_attachments'])
    expect(mock.findCalls('transaction_voucher_links', 'limit')).toEqual([[RECORD_LINK_LIMIT]])
  })

  it('an unbooked bank row with nothing tied to it has no links, and reads no pointer basis', async () => {
    expect(await transactionLinks(supabase, CO, bankRow())).toEqual([])
    expect(mock.findCalls('transactions', 'select')).toEqual([])
  })

  it('a pinned document is a pin, with no verifikat basis', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: DOC, link_basis: 'user_created', link_evidence: null }] })
    const links = await transactionLinks(supabase, CO, bankRow({ documents: [{ document_id: DOC, journal_entry_id: null, pinned_to_transaction: true }] }))
    expect(links).toEqual([{ relation: 'underlag', record_ref: `document:${DOC}`, basis: null, via: 'pin' }])
  })

  it('throws on a failed read, so unknown never reads as no links', async () => {
    mock.enqueue({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })
    await expect(transactionLinks(supabase, CO, bankRow())).rejects.toThrow()
  })
})

describe('invoiceLinks', () => {
  it('names the booking, each payment with its amount, the credit note pairing both ways, the quote, underlag and set-offs', async () => {
    mock.enqueue({ data: [{ journal_entry_id: JE, credited_invoice_id: null, converted_from_id: CN }] })
    mock.enqueue({
      data: [
        { id: 'ip-1', amount: '600', currency: 'SEK', payment_date: '2026-10-01', journal_entry_id: JE2, transaction_id: TX, link_basis: 'rule_amount_date', link_evidence: { score: 0.9 } },
        { id: 'ip-2', amount: '400', currency: 'SEK', payment_date: '2026-10-15', journal_entry_id: JE2, transaction_id: null, link_basis: null, link_evidence: null },
      ],
    })
    mock.enqueue({ data: [{ id: TX }] }) // the bank row's own pointer: same tie as ip-1
    mock.enqueue({ data: [{ id: CN }] }) // a credit note against it
    mock.enqueue({ data: [{ document_id: DOC }] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ id: 'so-1', supplier_invoice_id: SI, amount: '100', currency: 'SEK', setoff_date: '2026-10-20', journal_entry_id: JE2 }] })
    const links = await invoiceLinks(supabase, CO, INV)
    expect(links).toEqual([
      { relation: 'booked_by', record_ref: `journal_entry:${JE}`, basis: null },
      { relation: 'paid_by', record_ref: `transaction:${TX}`, basis: 'rule_amount_date', evidence: { score: 0.9 }, amount: 600, currency: 'SEK', date: '2026-10-01', journal_entry_id: JE2, invoice_payment_id: 'ip-1' },
      { relation: 'paid_by', record_ref: `journal_entry:${JE2}`, basis: null, amount: 400, currency: 'SEK', date: '2026-10-15', journal_entry_id: JE2, invoice_payment_id: 'ip-2' },
      { relation: 'credited_by', record_ref: `invoice:${CN}`, basis: null },
      { relation: 'converted_from', record_ref: `invoice:${CN}`, basis: null },
      { relation: 'underlag', record_ref: `document:${DOC}`, basis: null },
      { relation: 'set_off_against', record_ref: `supplier_invoice:${SI}`, basis: null, amount: 100, currency: 'SEK', date: '2026-10-20', journal_entry_id: JE2, setoff_id: 'so-1' },
    ])
    expectCompanyScopedAndBounded(['invoices', 'invoice_payments', 'transactions', 'invoice_underlag', 'invoice_attachments', 'counterparty_setoffs'])
    // A reversed set-off is no tie.
    expect(mock.findCalls('counterparty_setoffs', 'eq')).toEqual(expect.arrayContaining([['status', 'booked']]))
  })

  it('a credit note names the invoice it credits', async () => {
    mock.enqueue({ data: [{ journal_entry_id: null, credited_invoice_id: INV, converted_from_id: null }] })
    const links = await invoiceLinks(supabase, CO, CN)
    expect(links).toEqual([{ relation: 'credits', record_ref: `invoice:${INV}`, basis: null }])
  })
})

describe('supplierInvoiceLinks', () => {
  it('names the registration, payments, document, inbox item and credit pairing, each tie once', async () => {
    mock.enqueue({ data: [{ registration_journal_entry_id: JE, payment_journal_entry_id: JE2, transaction_id: TX, document_id: DOC, credited_invoice_id: null }] })
    mock.enqueue({ data: [{ id: 'sp-1', amount: '1249', currency: 'SEK', payment_date: '2026-10-28', journal_entry_id: JE2, transaction_id: TX, link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } }] })
    mock.enqueue({ data: [{ id: TX }] })
    mock.enqueue({ data: [{ id: CN }] })
    mock.enqueue({ data: [{ id: 'inbox-1', document_id: DOC }] })
    mock.enqueue({ data: [] })
    const links = await supplierInvoiceLinks(supabase, CO, SI)
    expect(links).toEqual([
      { relation: 'booked_by', record_ref: `journal_entry:${JE}`, basis: null },
      { relation: 'paid_by', record_ref: `transaction:${TX}`, basis: 'agent_proposed_user_approved', evidence: { pending_operation_id: OP }, amount: 1249, currency: 'SEK', date: '2026-10-28', journal_entry_id: JE2, supplier_invoice_payment_id: 'sp-1' },
      { relation: 'underlag', record_ref: `document:${DOC}`, basis: null },
      { relation: 'from_inbox', record_ref: `document:${DOC}`, basis: null, inbox_item_id: 'inbox-1' },
      { relation: 'credited_by', record_ref: `supplier_invoice:${CN}`, basis: null },
    ])
    expectCompanyScopedAndBounded(['supplier_invoices', 'supplier_invoice_payments', 'transactions', 'invoice_inbox_items', 'counterparty_setoffs'])
  })

  it('a supplier credit note names the invoice it credits', async () => {
    mock.enqueue({ data: [{ registration_journal_entry_id: null, payment_journal_entry_id: null, transaction_id: null, document_id: null, credited_invoice_id: SI }] })
    expect(await supplierInvoiceLinks(supabase, CO, CN)).toEqual([{ relation: 'credits', record_ref: `supplier_invoice:${SI}`, basis: null }])
  })
})

describe('readSkattekontoRow', () => {
  const ROW = {
    id: SKV,
    transaktionsidentitet: 123456,
    transaktionsdatum: '2026-10-12',
    forfallodatum: null,
    ranteberakningsdatum: null,
    transaktionstext: 'Arbetsgivaravgift',
    belopp_skatteverket: '-29.00',
    belopp_kronofogden: null,
    status: 'booked',
    is_ignored: null,
    journal_entry_id: JE,
    suggested_journal_entry_id: null,
    suggested_at: null,
    source: 'api',
    imported_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z',
  }

  it('returns the row with its verifikat, a split over other verifikat with their amounts, and rows sharing the verifikat', async () => {
    mock.enqueue({ data: ROW })
    mock.enqueue({ data: [{ id: 'skv-2' }] }) // another row on the same verifikat
    mock.enqueue({ data: [{ settlement_id: 'st-1' }] })
    mock.enqueue({
      data: [
        { settlement_id: 'st-1', journal_entry_id: JE, amount: '8', link_basis: 'user_confirmed', link_evidence: null },
        { settlement_id: 'st-1', journal_entry_id: JE2, amount: '-8', link_basis: 'user_confirmed', link_evidence: null },
      ],
    })
    const row = await readSkattekontoRow(supabase, CO, SKV)
    expect(row).toMatchObject({ skattekonto_transaction_id: SKV, transaktionsidentitet: 123456, belopp_skatteverket: -29, belopp_kronofogden: null, is_ignored: false, journal_entry_id: JE })
    expect(row).not.toHaveProperty('id')
    expect(row!.links).toEqual([
      { relation: 'booked_by', record_ref: `journal_entry:${JE}`, basis: null, via: 'pointer' },
      { relation: 'settled_with', record_ref: `journal_entry:${JE2}`, basis: 'user_confirmed', amount: -8, settlement_id: 'st-1' },
      { relation: 'shares_verifikat', record_ref: 'skattekonto_transaction:skv-2', basis: null },
    ])
    expectCompanyScopedAndBounded(['skattekonto_transactions', 'account_reconciliation_settlements'])
    expect(mock.findCalls('account_reconciliation_settlements', 'is')).toEqual([['undone_at', null], ['undone_at', null]])
  })

  it('an unlinked row names only the verifikat it is suggested to', async () => {
    mock.enqueue({ data: { ...ROW, journal_entry_id: null, suggested_journal_entry_id: JE2 } })
    const row = await readSkattekontoRow(supabase, CO, SKV)
    expect(row!.links).toEqual([{ relation: 'suggested_match', record_ref: `journal_entry:${JE2}`, basis: null }])
  })

  it('answers null for a row the company does not hold', async () => {
    mock.enqueue({ data: null })
    expect(await readSkattekontoRow(supabase, CO, SKV)).toBeNull()
  })
})

describe('documentLedgerLinks', () => {
  it('reads the verifikat basis and the customer invoices that rest on or were sent with the document', async () => {
    mock.enqueue({ data: [{ link_basis: 'import_carried_over', link_evidence: { source_system: 'sie' } }] })
    mock.enqueue({ data: [{ invoice_id: INV }] })
    mock.enqueue({ data: [{ invoice_id: CN }] })
    const links = await documentLedgerLinks(supabase, CO, DOC, {
      journal_entry: { journal_entry_id: JE },
      transactions: [],
      inbox_items: [{ inbox_item_id: 'inbox-1', created_journal_entry_id: null, created_supplier_invoice_id: null, matched_transaction_id: null }],
      supplier_invoices: [],
      expense_claims: [{ expense_claim_id: 'ec-1', journal_entry_id: JE2 }],
    })
    expect(links).toEqual([
      { relation: 'supports', record_ref: `journal_entry:${JE}`, basis: 'import_carried_over', evidence: { source_system: 'sie' } },
      { relation: 'underlag_of', record_ref: `invoice:${INV}`, basis: null },
      { relation: 'sent_with', record_ref: `invoice:${CN}`, basis: null },
      // An inbox item that became nothing yet has no record to open: it is left out.
      { relation: 'expense_claim', record_ref: `journal_entry:${JE2}`, basis: null, expense_claim_id: 'ec-1' },
    ])
    expectCompanyScopedAndBounded(['document_attachments', 'invoice_underlag', 'invoice_attachments'])
  })
})

describe('verifikatBookedRecords', () => {
  it('names the invoice, supplier invoice and skattekonto rows a verifikat books or pays', async () => {
    mock.enqueue({ data: [{ id: INV }] })
    mock.enqueue({ data: [{ id: SI }] })
    mock.enqueue({ data: [{ id: CN }] })
    mock.enqueue({ data: [{ id: SKV }] })
    expect(await verifikatBookedRecords(supabase, CO, JE)).toEqual([
      { relation: 'books', record_ref: `invoice:${INV}`, basis: null },
      { relation: 'books', record_ref: `supplier_invoice:${SI}`, basis: null },
      { relation: 'pays', record_ref: `supplier_invoice:${CN}`, basis: null, via: 'pointer' },
      { relation: 'books', record_ref: `skattekonto_transaction:${SKV}`, basis: null },
    ])
    expectCompanyScopedAndBounded(['invoices', 'supplier_invoices', 'skattekonto_transactions'])
    expect(mock.findCalls('supplier_invoices', 'eq')).toEqual(expect.arrayContaining([['registration_journal_entry_id', JE], ['payment_journal_entry_id', JE]]))
  })
})
