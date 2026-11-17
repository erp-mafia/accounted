/**
 * The review of one proposal as data (review-model.ts): the fixed template's
 * parts are read off the staged operation and nothing is invented. Pinned
 * here: the typed fields per operation type, the headline amount, where the
 * underlag comes from, which reason line is shown, when a required field is
 * missing, the history, and the order the walk takes.
 */
import { describe, expect, it } from 'vitest'
import type { PendingOperation } from '@/types'
import {
  headlineAmount,
  isAutoExpired,
  missingFields,
  proposalFacts,
  reviewHistory,
  reviewReason,
  stagedPostingLines,
  stepAfterLeaving,
  stepPosition,
  underlagOf,
  underlagState,
  vatDeclarationSummary,
  voucherFacts,
  type FactRow,
  type RowUnderlagRead,
} from '../review-model'

const DOC = '11111111-1111-4111-8111-111111111111'
const TX = '44444444-4444-4444-8444-444444444444'

function op(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_voucher',
    status: 'pending',
    title: 'Ny verifikation',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: 'Claude',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    agent_reason: null,
    created_at: '2026-11-14T21:09:07.000Z',
    resolved_at: null,
    updated_at: '2026-11-14T21:09:07.000Z',
    ...overrides,
  } as PendingOperation
}

const labels = (rows: FactRow[]) => rows.map((r) => (typeof r.label === 'string' ? r.label : r.label.key))
const VOUCHER_LINES = [
  { account_number: '4010', debit_amount: 2400, credit_amount: 0 },
  { account_number: '2641', debit_amount: 600, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 3000 },
]

describe('proposalFacts: the typed fields per operation type', () => {
  it('a new customer: name and type always, the rest only when staged', () => {
    const [rows] = proposalFacts('create_customer', { name: 'Provkund Äng AB', customer_type: 'swedish_business', email: null })!
    expect(labels(rows)).toEqual(['Namn', 'Typ'])
    expect(rows[1].value).toEqual({
      kind: 'text',
      text: 'swedish_business',
      valueKey: 'preview_value.customer_type.swedish_business',
    })
    const [full] = proposalFacts('create_customer', {
      name: 'A',
      customer_type: 'individual',
      customer_number: '1042',
      email: 'a@example.com',
      org_number: '556000-0000',
      personal_number_masked: '19******-****',
    })!
    expect(labels(full)).toEqual(['Namn', 'Typ', 'Kundnr', 'E-post', 'Org.nr', 'Personnr'])
  })

  it('a new transaction: date, text and the amount in its own currency', () => {
    const [rows] = proposalFacts('create_transaction', { date: '2026-11-13', description: 'Parkering', amount: -180, currency: 'EUR' })!
    expect(labels(rows)).toEqual(['Datum', 'Beskrivning', 'Belopp'])
    expect(rows[2].value).toEqual({ kind: 'money', amount: -180, currency: 'EUR' })
    // No number is a gap, never NaN.
    const [gap] = proposalFacts('create_transaction', { date: '2026-11-13', description: 'x' })!
    expect(gap[2].value).toEqual({ kind: 'money', amount: null, currency: 'SEK' })
  })

  it('a verifikat: date, text, series, and the momsdeklaration impact only when there is one', () => {
    const data = { entry_date: '2026-11-12', description: 'Hyra', lines: VOUCHER_LINES }
    expect(labels(proposalFacts('create_voucher', data)![0])).toEqual(['Datum', 'Beskrivning', 'Serie'])
    expect(voucherFacts(data)[2].value).toEqual({ kind: 'code', text: 'A' })
    // A toEntryPreview payload states no series: the engine picks it at commit.
    expect(labels(voucherFacts(data, false))).toEqual(['Datum', 'Beskrivning'])
    const withVat = { ...data, vat_declaration: { summary: 'Ruta 48 ökar med 600 kr', status: 'ok', counted: true, rutor_change: { '48': 600 } } }
    expect(labels(voucherFacts(withVat))).toContainEqual('preview_vat_declaration')
    expect(vatDeclarationSummary({ summary: 'x', status: 'ok', counted: true, rutor_change: {} })).toBeNull()
    expect(vatDeclarationSummary({ summary: 'x', status: 'not_vat_registered' })).toBeNull()
  })

  it('a categorisation: the entry date, and the bank amount only when it is not SEK', () => {
    expect(labels(proposalFacts('categorize_transaction', { date: '2026-11-10', amount: -500, currency: 'SEK' })![0])).toEqual(['Datum'])
    expect(labels(proposalFacts('categorize_transaction', { date: '2026-11-10', amount: -50, currency: 'USD' })![0])).toEqual([
      'Datum',
      'Banktransaktion',
    ])
  })

  it('a samlingsverifikat: a date range when the rows span several days', () => {
    const [rows] = proposalFacts('bulk_book_transactions', { tx_date: '2026-11-01', tx_date_to: '2026-11-05', tx_count: 3, tx_sum: -720, mode: 'link_existing' })!
    expect(rows[0].value).toEqual({ kind: 'message', key: 'preview_field.date_range', values: { from: '2026-11-01', to: '2026-11-05' } })
    expect(rows[2].value).toMatchObject({ kind: 'message', key: 'preview_bulk_link_existing' })
  })

  it('an invoice: head and totals as two groups; a registration and every other type state their own fields', () => {
    const groups = proposalFacts('create_invoice', { customer_name: 'Acme', invoice_date: '2026-11-01', due_date: '2026-12-01', subtotal: 100, vat_amount: 25, total: 125 })!
    expect(groups.map(labels)).toEqual([
      ['Kund', 'Datum', 'preview_field.due_date'],
      ['Netto', 'Moms', 'Totalt'],
    ])
    expect(groups[1][2].strong).toBe(true)
    expect(proposalFacts('create_invoice', { mode: 'register_booked', customer_name: 'Acme' })).toBeNull()
    expect(proposalFacts('update_supplier', { name: 'x' })).toBeNull()
  })
})

describe('headlineAmount', () => {
  it('reads the amount the preview states, signed, in its currency', () => {
    expect(headlineAmount(op({ preview_data: { amount: -180, currency: 'SEK' } }))).toEqual({ value: -180, currency: 'SEK' })
    expect(headlineAmount(op({ preview_data: { total: 125, currency: 'EUR' } }))).toEqual({ value: 125, currency: 'EUR' })
  })

  it('falls back to the debit total of the verifikat, in SEK', () => {
    expect(headlineAmount(op({ preview_data: { lines: VOUCHER_LINES, total_debit: 3000 } }))).toEqual({ value: 3000, currency: 'SEK' })
    expect(headlineAmount(op({ preview_data: { journal_entry: { lines: VOUCHER_LINES } } }))).toEqual({ value: 3000, currency: 'SEK' })
  })

  it('is null when the proposal names no amount', () => {
    expect(headlineAmount(op({ operation_type: 'create_customer', preview_data: { name: 'A' } }))).toBeNull()
  })
})

describe('underlagOf', () => {
  it('shows the file the proposal carries', () => {
    const underlag = underlagOf(op({ params: { document_id: DOC }, preview_data: { document_file_name: 'kvitto.pdf' } }))
    expect(underlag?.document).toEqual({ kind: 'document', documentId: DOC, fileName: 'kvitto.pdf', mime: null })
    expect(underlag?.missing).toBe(false)
  })

  it('moves the document of a pairing preview to the underlag slot, beside the bank row', () => {
    const underlag = underlagOf(
      op({
        operation_type: 'attach_document_to_transaction',
        params: { document_id: DOC },
        preview_data: { transaction_date: '2026-11-02', transaction_description: 'CIRCLE K', transaction_amount: -612, document_file_name: 'k.jpg' },
      }),
    )
    expect(underlag?.document).toMatchObject({ documentId: DOC, fileName: 'k.jpg' })
    expect(underlag?.bankRow).toEqual({ date: '2026-11-02', text: 'CIRCLE K', amount: -612, currency: 'SEK' })
  })

  it('a categorisation points at its bank row, whose own underlag the review looks up', () => {
    const underlag = underlagOf(
      op({ operation_type: 'categorize_transaction', params: { transaction_id: TX }, preview_data: { date: '2026-11-10', amount: 500, lines: VOUCHER_LINES } }),
    )
    // The preview states the amount unsigned and no bank text: no row is drawn from it.
    expect(underlag).toEqual({ document: null, bankRow: null, transactionId: TX, rowUnderlagExpected: true, missing: false })
  })

  it('a payment matched to an invoice points at its bank row too (crm#1977)', () => {
    const underlag = underlagOf(
      op({
        operation_type: 'match_transaction_invoice',
        params: { transaction_id: TX, invoice_id: DOC },
        preview_data: { transaction_date: '2026-11-10', transaction_description: 'BG 5050-1055', transaction_amount: 12500, invoice_number: '1042' },
      }),
    )
    expect(underlag).toEqual({
      document: null,
      bankRow: { date: '2026-11-10', text: 'BG 5050-1055', amount: 12500, currency: 'SEK' },
      transactionId: TX,
      // The invoice is what the payment is booked from: a row without a file is no gap.
      rowUnderlagExpected: false,
      missing: false,
    })
  })

  it.each([
    'settle_rot_rut_payout',
    'uncategorize_transaction',
    'ignore_transaction',
    'link_transaction_journal_entry',
    'match_batch_allocate',
    'match_expense_payout',
    'detach_document_from_transaction',
    'some_future_type',
  ])('every type that names one bank row has the row looked up: %s', (operation_type) => {
    expect(underlagOf(op({ operation_type, params: { transaction_id: TX } }))).toMatchObject({
      document: null,
      transactionId: TX,
      rowUnderlagExpected: false,
    })
  })

  it('reads no bank row where the proposal carries its own file, or names no bank row', () => {
    // The file of a pairing is the proposal's own.
    expect(
      underlagOf(op({ operation_type: 'attach_document_to_transaction', params: { transaction_id: TX, document_id: DOC } }))?.transactionId,
    ).toBeNull()
    // A skattekonto row is no bank row.
    expect(underlagOf(op({ operation_type: 'book_skattekonto_row', params: { transaction_id: TX } }))).toBeNull()
    // A batch names many rows; the slot shows one file.
    expect(underlagOf(op({ operation_type: 'bulk_book_transactions', params: { tx_ids: [TX] } }))).toBeNull()
    expect(underlagOf(op({ operation_type: 'ignore_transaction', params: { transaction_id: 'not-an-id' } }))).toBeNull()
  })

  it('says underlag saknas only when the staging tool did', () => {
    expect(underlagOf(op({ preview_data: { lines: VOUCHER_LINES, compliance_warning: 'No document attached.' } }))?.missing).toBe(true)
    // A verifikat staged with its document carries no such warning.
    expect(underlagOf(op({ preview_data: { lines: VOUCHER_LINES } }))).toBeNull()
  })

  it('is null for a proposal with no underlag to speak of', () => {
    expect(underlagOf(op({ operation_type: 'create_customer', preview_data: { name: 'A' } }))).toBeNull()
  })
})

describe('underlagState: the one thing the underlag slot shows', () => {
  const FILE = { kind: 'document' as const, documentId: DOC, fileName: 'kvitto.pdf', mime: 'application/pdf' }
  const read = (over: Partial<RowUnderlagRead> = {}): RowUnderlagRead => ({ loading: false, failed: false, document: null, ...over })
  const match = underlagOf(
    op({
      operation_type: 'match_transaction_invoice',
      params: { transaction_id: TX },
      preview_data: { transaction_date: '2026-11-10', transaction_amount: 12500 },
    }),
  )!
  const categorisation = underlagOf(op({ operation_type: 'categorize_transaction', params: { transaction_id: TX } }))!
  /** The heading heads these states and nothing else. */
  const headed = (kind: string) => kind === 'loading' || kind === 'failed' || kind === 'missing'

  it('shows the file on the bank row of a matched payment (crm#1977)', () => {
    expect(underlagState(match, read({ document: FILE }), false)).toEqual({ kind: 'document', document: FILE })
  })

  it('shows nothing, and no heading, over the bank row of a matched payment without a file', () => {
    const state = underlagState(match, read(), false)
    expect(state).toEqual({ kind: 'none' })
    expect(headed(state.kind)).toBe(false)
  })

  it('holds no room in the drawer while a read that may find nothing is out, and does where the slot keeps its place', () => {
    expect(underlagState(match, read({ loading: true }), false)).toEqual({ kind: 'none' })
    expect(underlagState(match, read({ loading: true }), true)).toEqual({ kind: 'loading' })
  })

  it('says so when the bank row could not be read', () => {
    expect(underlagState(match, read({ failed: true }), false)).toEqual({ kind: 'failed' })
  })

  it('a categorisation: the skeleton while reading, the file when the row has one, underlag saknas when it has none', () => {
    expect(underlagState(categorisation, read({ loading: true }), false)).toEqual({ kind: 'loading' })
    expect(underlagState(categorisation, read({ document: FILE }), false)).toEqual({ kind: 'document', document: FILE })
    expect(underlagState(categorisation, read(), false)).toEqual({ kind: 'missing' })
    expect(underlagState(categorisation, read({ failed: true }), false)).toEqual({ kind: 'failed' })
  })

  it('the proposal\'s own file needs no read; a verifikat staged without one says underlag saknas', () => {
    const own = underlagOf(op({ params: { document_id: DOC } }))!
    expect(underlagState(own, read(), false)).toMatchObject({ kind: 'document', document: { documentId: DOC } })
    const none = underlagOf(op({ preview_data: { lines: VOUCHER_LINES, compliance_warning: 'No document attached.' } }))!
    expect(underlagState(none, read(), false)).toEqual({ kind: 'missing' })
  })

  it('a file on the row wins over a warning staged before the row had one', () => {
    const warned = { ...categorisation, missing: true }
    expect(underlagState(warned, read({ document: FILE }), false)).toEqual({ kind: 'document', document: FILE })
    expect(underlagState(warned, read(), false)).toEqual({ kind: 'missing' })
  })

  it('every state but the three it heads comes without the heading', () => {
    const states = [
      underlagState(match, read(), false),
      underlagState(match, read({ loading: true }), false),
      underlagState(match, read({ document: FILE }), true),
    ]
    expect(states.map((state) => headed(state.kind))).toEqual([false, false, false])
  })
})

describe('reviewReason: one reason line', () => {
  it('prefers the reason the stager gave, and keeps a differing audit note', () => {
    expect(reviewReason(op({ agent_reason: 'Ny kund på ordern', params: { notes: 'Order 1042' } }))).toEqual({
      attention: null,
      reason: 'Ny kund på ordern',
      note: 'Order 1042',
    })
  })

  it('falls back to the audit note, and never shows it twice', () => {
    expect(reviewReason(op({ params: { notes: 'Enligt hyresavi' } }))).toMatchObject({ reason: 'Enligt hyresavi', note: null })
    expect(reviewReason(op({ agent_reason: 'Samma', params: { notes: 'Samma' } }))).toMatchObject({ reason: 'Samma', note: null })
  })

  it('has no reason when the proposal carries none', () => {
    expect(reviewReason(op({ agent_reason: '  ' }))).toEqual({ attention: null, reason: null, note: null })
  })

  it('raises the staged warning as the attention line, but leaves the VAT explanation to the invoice preview', () => {
    expect(reviewReason(op({ preview_data: { compliance_warning: 'No document.' } })).attention).toEqual({ kind: 'missing_underlag' })
    expect(
      reviewReason(op({ operation_type: 'update_supplier', preview_data: { compliance_warning: 'Bankgirot ändras.' } })).attention,
    ).toEqual({ kind: 'note', text: 'Bankgirot ändras.' })
    expect(
      reviewReason(op({ operation_type: 'create_invoice', preview_data: { vat_warnings: [{ code: 'x', message_sv: 'Moms 25 %' }] } })).attention,
    ).toBeNull()
  })
})

describe('missingFields', () => {
  const missing = (o: Partial<PendingOperation>) =>
    missingFields(op(o)).map((label) => (typeof label === 'string' ? label : label.key))

  it('is empty for a proposal staged in full', () => {
    expect(missing({ preview_data: { lines: VOUCHER_LINES } })).toEqual([])
    expect(missing({ operation_type: 'create_customer', preview_data: { name: 'A' } })).toEqual([])
    expect(missing({ operation_type: 'create_transaction', preview_data: { date: '2026-11-13', amount: 0 } })).toEqual([])
  })

  it('names what a booking proposal lacks', () => {
    expect(missing({ preview_data: { entry_date: '2026-11-12', lines: [] } })).toEqual(['preview_account'])
    expect(missing({ operation_type: 'categorize_transaction', preview_data: { amount: -500 } })).toEqual(['preview_account'])
    // The legacy summary names both accounts: nothing is missing.
    expect(missing({ operation_type: 'categorize_transaction', preview_data: { debit_account: '5410', credit_account: '1930' } })).toEqual([])
  })

  it('names every missing field of a record', () => {
    expect(missing({ operation_type: 'create_transaction', preview_data: { description: 'x' } })).toEqual(['Datum', 'Belopp'])
    expect(missing({ operation_type: 'create_invoice', preview_data: { customer_name: '', total: 125 } })).toEqual(['Kund'])
  })

  it('never holds back a resolved proposal, a registration, or a type without a list', () => {
    expect(missing({ status: 'committed', preview_data: {} })).toEqual([])
    expect(missing({ operation_type: 'update_supplier', preview_data: {} })).toEqual([])
    expect(missing({ operation_type: 'create_invoice', preview_data: { mode: 'register_booked' } })).toEqual([])
  })
})

describe('reviewHistory', () => {
  it('a pending proposal: when it was staged, and the instructions the agent retrieved', () => {
    expect(reviewHistory(op({ agent_metadata: { skills_loaded: ['month-end'] } }))).toEqual([
      { kind: 'staged', at: '2026-11-14T21:09:07.000Z' },
      { kind: 'instructions', slugs: ['month-end'] },
    ])
  })

  it('says how a resolved proposal ended', () => {
    const at = '2026-11-15T08:00:00.000Z'
    expect(reviewHistory(op({ status: 'committed', resolved_at: at })).at(-1)).toEqual({ kind: 'approved', at })
    expect(
      reviewHistory(op({ status: 'rejected', resolved_at: at, rejection_category: 'wrong_amount', rejection_reason: 'Fel belopp ' })).at(-1),
    ).toEqual({ kind: 'rejected', at, category: 'wrong_amount', reason: 'Fel belopp' })
    const expired = op({ status: 'rejected', resolved_at: at, result_data: { auto_rejected: true, reason: 'expired' } })
    expect(isAutoExpired(expired)).toBe(true)
    expect(reviewHistory(expired).at(-1)).toEqual({ kind: 'expired', at })
    expect(
      reviewHistory(op({ status: 'rejected', resolved_at: at, result_data: { auto_rejected: true, reason: 'already_booked' } })).at(-1),
    ).toEqual({ kind: 'handled_elsewhere', at })
    expect(reviewHistory(op({ status: 'failed_partial', resolved_at: at })).at(-1)).toEqual({ kind: 'failed_partial', at })
  })
})

describe('the walk: next and previous follow the list order', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('knows its place and its neighbours', () => {
    expect(stepPosition(ids, 'a')).toEqual({ index: 0, count: 4, previous: null, next: 'b' })
    expect(stepPosition(ids, 'c')).toEqual({ index: 2, count: 4, previous: 'b', next: 'd' })
    expect(stepPosition(ids, 'd')).toEqual({ index: 3, count: 4, previous: 'c', next: null })
    expect(stepPosition(ids, 'gone')).toMatchObject({ index: -1, previous: null, next: null })
    expect(stepPosition(ids, null)).toMatchObject({ index: -1 })
  })

  it('moves on to the next one still waiting after an approval or a rejection', () => {
    expect(stepAfterLeaving(ids, 'b', new Set(['a', 'c', 'd']))).toBe('c')
    // The one after it went too (a bulk approval elsewhere): skip to the next.
    expect(stepAfterLeaving(ids, 'b', new Set(['a', 'd']))).toBe('d')
  })

  it('is through when nothing after it waits: what was skipped stays in Rutin', () => {
    expect(stepAfterLeaving(ids, 'd', new Set(['a', 'b', 'c']))).toBeNull()
    expect(stepAfterLeaving(ids, 'unknown', new Set(ids))).toBeNull()
  })
})

describe('stagedPostingLines', () => {
  it('finds the verifikat rows wherever the preview keeps them', () => {
    expect(stagedPostingLines({ lines: VOUCHER_LINES })).toHaveLength(3)
    expect(stagedPostingLines({ preview_lines: [{ account: '1930', debit: 10, credit: 0 }] })).toHaveLength(1)
    expect(stagedPostingLines({ journal_entry: { lines: VOUCHER_LINES } })).toHaveLength(3)
    // Invoice items are not a kontering.
    expect(stagedPostingLines({ items: [{ description: 'Timmar', quantity: 2 }] })).toEqual([])
  })
})

describe('the review template of the types a person checks against a file', () => {
  const lines = (debit: number) => [
    { account_number: '6110', debit_amount: debit, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: debit },
  ]

  it('heads a rättelse and a storno with what they post, not with the verifikat they replace', () => {
    expect(headlineAmount({ preview_data: { original: { lines: lines(1890.5) }, correction: { lines: lines(735) } } })).toEqual({
      value: 735,
      currency: 'SEK',
    })
    expect(headlineAmount({ preview_data: { original: { lines: lines(125) }, reversal: { lines: lines(125) } } })).toEqual({
      value: 125,
      currency: 'SEK',
    })
  })

  it('states a supplier invoice from the inbox as who, which invoice, when and how it is paid, then the sums', () => {
    const groups = proposalFacts('create_supplier_invoice_from_inbox', {
      will: 'register supplier invoice',
      extracted_supplier_name: 'Simulerad Telekom AB',
      supplier_invoice_number: '4411',
      invoice_date: '2026-11-04',
      due_date: '2026-12-04',
      payment_reference: '4411',
      invoice_account: 'BG 5050-1055',
      vat_treatment: 'standard_25',
      subtotal: 3528.8,
      vat_amount: 882.2,
      total: 4411,
      currency: 'SEK',
    })
    expect(groups?.map((group) => group.map((fact) => fact.id))).toEqual([
      ['supplier_name', 'supplier_invoice_number', 'invoice_date', 'due_date', 'payment_reference', 'invoice_account'],
      ['subtotal', 'vat_amount', 'total'],
    ])
    expect(groups?.[1][2]).toMatchObject({ strong: true, value: { kind: 'money', amount: 4411, currency: 'SEK' } })
  })

  it('states the invoice of a match: the bank row is the underlag', () => {
    const [rows] = proposalFacts('match_transaction_invoice', {
      invoice_number: '186',
      customer_name: 'Fjällgård Data 1 AB',
      invoice_date: '2026-09-28',
      invoice_total: 7000,
      invoice_currency: 'SEK',
      transaction_amount: 7000,
    }) ?? [[]]
    expect(rows.map((fact) => fact.id)).toEqual(['invoice_number', 'customer_name', 'invoice_date', 'invoice_total'])
  })
})
