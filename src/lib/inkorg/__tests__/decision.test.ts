import { describe, expect, it } from 'vitest'
import { ALL_STARTABLE, MAX_DECISION_ACTIONS, UNDO_OF, bookedOnAccount, canUndo, focusDecision, rowStatus, type DecisionAction, type InkorgStartable } from '../decision'
import { makeItem, reading } from './fixtures'

describe('focusDecision', () => {
  it('asks how an unpaid invoice is paid: register it, pay it in the bank, or it was paid and gets its bank row', () => {
    const d = focusDecision(
      makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-30', invoiceDate: '2026-10-01' } }) }),
    )
    expect(d.question).toBe('invoice_paid')
    expect(d.evidence).toEqual({ kind: 'due', date: '2026-10-30' })
    expect(d.actions).toEqual(['register_invoice', 'pay_in_bank', 'match_purchase'])
    expect(d.editorEscape).toBe(true)
  })

  it('keeps "Inte ett underlag" for an unpaid invoice as a quiet link once it falls off the three', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }))
    expect(d.actions).not.toContain('not_underlag')
    expect(d.quietActions).toEqual(['not_underlag'])
  })

  it('never marks an invoice paid without a bank row: "already paid" is the picker', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }))
    expect(d.actions).toContain('match_purchase')
    for (const action of d.actions) expect(['register_invoice', 'pay_in_bank', 'match_purchase']).toContain(action)
  })

  it('falls back to the invoice date when no due date was read', () => {
    const d = focusDecision(makeItem({ kind_hint: 'supplier_invoice', extracted_data: reading({ invoice: { invoiceDate: '2026-10-01' } }) }))
    expect(d.evidence).toEqual({ kind: 'issued', date: '2026-10-01' })
  })

  it('asks who paid a receipt: the company account, privately (an utlägg), or not an underlag', () => {
    const d = focusDecision(
      makeItem({ extracted_data: reading({ documentKind: 'receipt', payment: { method: 'card', cardLast4: '4471' }, totals: { total: 120 } }) }),
    )
    expect(d.question).toBe('who_paid')
    expect(d.evidence).toEqual({ kind: 'paid_with', method: 'card', cardLast4: '4471' })
    expect(d.actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
  })

  it('shows the amount and date when nothing says how it was paid, and nothing when nothing was read', () => {
    const read = focusDecision(
      makeItem({ extracted_data: reading({ totals: { total: 99 }, invoice: { invoiceDate: '2026-10-02', currency: 'EUR' } }) }),
    )
    expect(read.question).toBe('who_paid')
    expect(read.evidence).toEqual({ kind: 'amount', amount: 99, currency: 'EUR', date: '2026-10-02' })
    expect(focusDecision(makeItem()).evidence).toBeNull()
  })

  it('credits a credit note on the invoice it references, never as a payable of its own', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }))
    expect(d.question).toBe('credit_note')
    expect(d.actions).toEqual(['credit', 'not_underlag'])
    expect(d.actions).not.toContain('register_invoice')
  })

  it('books a matched purchase, or releases the match', () => {
    const d = focusDecision(makeItem({ matched_transaction_id: 'tx-1' }))
    expect(d.question).toBe('book_purchase')
    expect(d.actions).toEqual(['book', 'unmatch'])
    expect(d.editorEscape).toBe(false)
  })

  it('never offers to book a match whose transaction is booked without this underlag (the route would refuse)', () => {
    const d = focusDecision(
      makeItem({ matched_transaction_id: 'tx-1', matched_transaction_journal_entry_id: 'je-2', underlag_status: 'unlinked_locked' }),
    )
    expect(d.question).toBe('underlag_off_entry')
    expect(d.evidence).toEqual({ kind: 'underlag_status', status: 'unlinked_locked' })
    expect(d.actions).toEqual(['open_matched_entry', 'unmatch'])
    expect(d.actions).not.toContain('book')
  })

  it('offers to read again or to drop a document that could not be read', () => {
    expect(focusDecision(makeItem({ status: 'error' })).actions).toEqual(['retry_reading', 'not_underlag'])
    expect(focusDecision(makeItem({ status: 'error', document_id: null })).actions).toEqual(['not_underlag'])
  })

  it('offers nothing while the reading is in flight', () => {
    const d = focusDecision(makeItem({ status: 'processing' }))
    expect(d.question).toBe('reading')
    expect(d.actions).toEqual([])
  })

  it('points a booked item at what it became', () => {
    expect(focusDecision(makeItem({ created_supplier_invoice_id: 'si-1' })).actions).toEqual(['open_supplier_invoice'])
    expect(focusDecision(makeItem({ created_journal_entry_id: 'je-1' })).actions).toEqual(['open_entry'])
  })

  it('never offers more than three answers', () => {
    const items = [
      makeItem(),
      makeItem({ kind_hint: 'supplier_invoice' }),
      makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }),
      makeItem({ matched_transaction_id: 'tx-1' }),
      makeItem({ status: 'error' }),
      makeItem({ status: 'processing' }),
      makeItem({ created_journal_entry_id: 'je-1' }),
    ]
    for (const item of items) expect(focusDecision(item).actions.length).toBeLessThanOrEqual(MAX_DECISION_ACTIONS)
    const match = { transaction_id: 'tx-1', date: '2026-10-02', amount: -10, currency: 'SEK', counterparty: null, basis: 'rule_amount_date' as const, evidence_level: 'trolig' as const }
    for (const documentKind of ['supplier_invoice', 'receipt'] as const) {
      expect(focusDecision(makeItem({ extracted_data: reading({ documentKind }) }), { bankMatch: match }).actions.length).toBeLessThanOrEqual(MAX_DECISION_ACTIONS)
    }
  })
})

describe('Ångra', () => {
  it('only where an endpoint truly undoes it: a match and its release', () => {
    expect(UNDO_OF).toEqual({ match_purchase: 'unmatch', accept_bank_match: 'unmatch', unmatch: 'rematch' })
    const none: DecisionAction[] = ['register_invoice', 'register_and_settle', 'pay_in_bank', 'expense', 'book', 'not_underlag', 'retry_reading', 'credit']
    for (const action of none) expect(canUndo(action)).toBe(false)
    expect(canUndo('match_purchase')).toBe(true)
    expect(canUndo('unmatch')).toBe(true)
    expect(canUndo('accept_bank_match')).toBe(true)
  })
})

describe('focusDecision: the bank was checked on arrival', () => {
  const MATCH = {
    transaction_id: 'tx-1',
    date: '2026-10-02',
    amount: -1250,
    currency: 'SEK',
    counterparty: 'Leverantören AB',
    basis: 'rule_ocr_reference' as const,
    evidence_level: 'exakt' as const,
  }

  it('asks "Ser redan betald ut" for an invoice it found a payment for, with the bank row as evidence', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }), { bankMatch: MATCH })
    expect(d.question).toBe('already_paid')
    expect(d.evidence).toEqual({
      kind: 'bank_match', transactionId: 'tx-1', date: '2026-10-02', amount: -1250, currency: 'SEK', counterparty: 'Leverantören AB', basis: 'rule_ocr_reference', level: 'exakt',
    })
  })

  it('registers a paid-looking invoice and settles it against the row, picks another row, or registers it unpaid', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }), { bankMatch: MATCH })
    expect(d.actions).toEqual(['register_and_settle', 'match_purchase', 'register_invoice'])
    // Dropping it falls off the three and stays a quiet link.
    expect(d.quietActions).toEqual(['not_underlag'])
    // The supplier ledger sees the invoice: it is never booked straight off the bank row.
    expect(d.actions).not.toContain('accept_bank_match')
  })

  it('links a receipt to the row, picks another row, or offers the utlägg as the other answer', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }), { bankMatch: MATCH })
    expect(d.actions).toEqual(['accept_bank_match', 'match_purchase', 'expense'])
    expect(d.quietActions).toEqual(['not_underlag'])
  })

  it('says what paired them, so the page can say why in plain words', () => {
    for (const basis of ['rule_ocr_reference', 'rule_counterparty', 'rule_amount_date'] as const) {
      const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }), { bankMatch: { ...MATCH, basis } })
      expect(d.evidence).toMatchObject({ kind: 'bank_match', basis })
    }
  })

  it('leaves a credit note and an item without a match as they were', () => {
    expect(focusDecision(makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }), { bankMatch: MATCH }).question).toBe('credit_note')
    expect(focusDecision(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }), { bankMatch: null }).question).toBe('who_paid')
    expect(focusDecision(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) })).question).toBe('who_paid')
  })
})

describe('focusDecision: what the company has switched off', () => {
  const MATCH = {
    transaction_id: 'tx-1',
    date: '2026-10-02',
    amount: -1250,
    currency: 'SEK',
    counterparty: 'Leverantören AB',
    basis: 'rule_ocr_reference' as const,
    evidence_level: 'exakt' as const,
  }
  // The sole-trader profile: Leverantörsfakturor and Utlägg off, kontantmetoden.
  const SOLE_TRADER: InkorgStartable = { supplierInvoices: false, expenses: false, soleTrader: true, cashMethod: true }
  const AB_NO_AP: InkorgStartable = { supplierInvoices: false, expenses: false, soleTrader: false, cashMethod: false }
  const invoice = () => makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-30' } }) })
  const receipt = () => makeItem({ extracted_data: reading({ documentKind: 'receipt' }) })
  const STARTS: DecisionAction[] = ['register_invoice', 'register_and_settle', 'pay_in_bank', 'expense']

  it('answers exactly as before when nothing says otherwise: every package on', () => {
    expect(focusDecision(invoice(), { startable: ALL_STARTABLE }).actions).toEqual(['register_invoice', 'pay_in_bank', 'match_purchase'])
    expect(focusDecision(receipt(), { startable: ALL_STARTABLE }).actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
    expect(focusDecision(invoice(), { bankMatch: MATCH, startable: ALL_STARTABLE }).actions).toEqual(['register_and_settle', 'match_purchase', 'register_invoice'])
  })

  it('never offers an answer the server refuses while its package is off', () => {
    for (const startable of [SOLE_TRADER, AB_NO_AP]) {
      for (const item of [invoice(), receipt()]) {
        for (const bankMatch of [MATCH, null]) {
          const d = focusDecision(item, { bankMatch, startable })
          for (const action of [...d.actions, ...d.quietActions]) expect(STARTS).not.toContain(action)
          expect(d.actions.length).toBeLessThanOrEqual(MAX_DECISION_ACTIONS)
        }
      }
    }
  })

  it('kontantmetoden without Leverantörsfakturor: pay from the document, already paid, or paid with the owner\'s money', () => {
    const d = focusDecision(invoice(), { startable: SOLE_TRADER })
    expect(d.question).toBe('invoice_paid')
    expect(d.actions).toEqual(['pay_in_bank_unregistered', 'match_purchase', 'owner_paid'])
    expect(d.quietActions).toEqual(['not_underlag'])
  })

  it('a paid-looking invoice without Leverantörsfakturor is linked and booked with its row, or waits for its payment', () => {
    const d = focusDecision(invoice(), { bankMatch: MATCH, startable: SOLE_TRADER })
    expect(d.question).toBe('already_paid')
    expect(d.actions).toEqual(['accept_bank_match', 'match_purchase', 'wait_for_payment'])
  })

  it('faktureringsmetoden without Leverantörsfakturor sends an unpaid invoice to Anpassa: it is a debt the day it arrives', () => {
    expect(focusDecision(invoice(), { startable: AB_NO_AP }).actions).toEqual(['turn_on_supplier_invoices', 'match_purchase'])
    expect(focusDecision(invoice(), { bankMatch: MATCH, startable: AB_NO_AP }).actions).toEqual(['accept_bank_match', 'match_purchase', 'turn_on_supplier_invoices'])
  })

  it('a receipt paid privately in an enskild firma is the owner\'s money, in an aktiebolag an utlägg that needs Utlägg', () => {
    expect(focusDecision(receipt(), { startable: SOLE_TRADER }).actions).toEqual(['match_purchase', 'owner_paid', 'not_underlag'])
    expect(focusDecision(receipt(), { bankMatch: MATCH, startable: SOLE_TRADER }).actions).toEqual(['accept_bank_match', 'match_purchase', 'owner_paid'])
    expect(focusDecision(receipt(), { startable: AB_NO_AP }).actions).toEqual(['match_purchase', 'turn_on_expenses', 'not_underlag'])
  })

  it('keeps the utlägg for an enskild firma that has Utlägg on', () => {
    const startable = { ...SOLE_TRADER, expenses: true }
    expect(focusDecision(receipt(), { startable }).actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
  })
})

describe('rowStatus', () => {
  const MATCH = {
    transaction_id: 'tx-1',
    date: '2026-10-02',
    amount: -1250,
    currency: 'SEK',
    counterparty: 'Leverantören AB',
    basis: 'rule_ocr_reference' as const,
    evidence_level: 'exakt' as const,
  }
  const invoice = () => makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-31' } }) })

  it('says an invoice with a due date is to be paid, while nothing says it is paid', () => {
    expect(rowStatus(invoice())).toEqual({ kind: 'to_pay', dueDate: '2026-10-31' })
    expect(rowStatus(invoice(), null)).toEqual({ kind: 'to_pay', dueDate: '2026-10-31' })
  })

  it('says it looks paid once the bank row it looks paid by is known', () => {
    expect(rowStatus(invoice(), MATCH)).toEqual({ kind: 'looks_paid' })
    expect(rowStatus(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }), MATCH)).toEqual({ kind: 'looks_paid' })
  })

  it('says it looks paid from the first sight, off the match the list read carries', () => {
    expect(rowStatus({ ...invoice(), bank_match: MATCH })).toEqual({ kind: 'looks_paid' })
    expect(rowStatus({ ...invoice(), bank_match: null })).toEqual({ kind: 'to_pay', dueDate: '2026-10-31' })
  })

  it('lets a later read win over the list: the focus view found the row booked since, or found one', () => {
    expect(rowStatus({ ...invoice(), bank_match: MATCH }, null)).toEqual({ kind: 'to_pay', dueDate: '2026-10-31' })
    expect(rowStatus({ ...invoice(), bank_match: null }, MATCH)).toEqual({ kind: 'looks_paid' })
    // Unknown to a later read: the list's own answer stands.
    expect(rowStatus({ ...invoice(), bank_match: MATCH }, undefined)).toEqual({ kind: 'looks_paid' })
  })

  it('never calls a credit note paid', () => {
    expect(rowStatus(makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }), MATCH)).toEqual({ kind: 'waiting' })
    expect(rowStatus({ ...makeItem({ extracted_data: reading({ documentKind: 'credit_note' }) }), bank_match: MATCH })).toEqual({ kind: 'waiting' })
  })

  it('a matched or booked item is past the question, whatever the list carries', () => {
    expect(rowStatus({ ...invoice(), matched_transaction_id: 'tx-1', bank_match: MATCH })).toEqual({ kind: 'linked' })
    expect(rowStatus({ ...invoice(), created_supplier_invoice_id: 'si-1', bank_match: MATCH })).toEqual({ kind: 'done' })
  })

  it('says where an item stands when that is the news: unreadable, reading, linked, done', () => {
    expect(rowStatus(makeItem({ status: 'error', extracted_data: null }))).toEqual({ kind: 'unreadable' })
    expect(rowStatus(makeItem({ status: 'processing', extracted_data: null }))).toEqual({ kind: 'reading' })
    expect(rowStatus(makeItem({ matched_transaction_id: 'tx-9', extracted_data: reading({ documentKind: 'receipt' }) }))).toEqual({ kind: 'linked' })
    expect(rowStatus(makeItem({ created_supplier_invoice_id: 'si-1' }))).toEqual({ kind: 'done' })
  })

  it('says a receipt or a document without a due date waits for you', () => {
    expect(rowStatus(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }))).toEqual({ kind: 'waiting' })
    expect(rowStatus(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) }))).toEqual({ kind: 'waiting' })
  })
})

describe('bookedOnAccount', () => {
  it('reads the net cost off a proposal: its largest debit, past the VAT and the bank', () => {
    expect(
      bookedOnAccount([
        { account_number: '2641', debit_amount: 250 },
        { account_number: '5420', debit_amount: 1000 },
        { account_number: '1930', debit_amount: 0 },
      ]),
    ).toBe('5420')
  })

  it('takes the first of two equal debits', () => {
    expect(bookedOnAccount([{ account_number: '5410', debit_amount: 100 }, { account_number: '5420', debit_amount: 100 }])).toBe('5410')
  })

  it('has nothing for no proposal or one without a debit', () => {
    expect(bookedOnAccount(null)).toBeNull()
    expect(bookedOnAccount([])).toBeNull()
    expect(bookedOnAccount([{ account_number: '1930', debit_amount: 0 }])).toBeNull()
  })
})
