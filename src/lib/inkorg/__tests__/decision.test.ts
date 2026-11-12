import { describe, expect, it } from 'vitest'
import { ALL_STARTABLE, MAX_DECISION_ACTIONS, UNDO_OF, bookedOnAccount, canUndo, focusDecision, nothingRead, rowStatus, type DecisionAction, type InkorgStartable } from '../decision'
import { makeItem, reading } from './fixtures'

describe('focusDecision', () => {
  it('asks how an unpaid invoice is paid: register it, pay it in the bank, or it was paid and gets its bank row', () => {
    const d = focusDecision(
      makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-30', invoiceDate: '2026-10-01' } }) }),
      { today: '2026-10-20' },
    )
    expect(d.question).toBe('invoice_paid')
    expect(d.evidence).toEqual({ kind: 'due', date: '2026-10-30', overdue: false })
    expect(d.actions).toEqual(['register_invoice', 'pay_in_bank', 'match_purchase'])
    expect(d.editorEscape).toBe(true)
  })

  it('keeps the removal (Ta bort ur Inkorgen) for an unpaid invoice as a quiet link once it falls off the three', () => {
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
    expect(d.evidence).toEqual({ kind: 'paid_with', method: 'card', cardLast4: '4471', cardKnown: false })
    expect(d.actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
  })

  it('the card number is the card that paid only when the company knows it (crm#1534)', () => {
    const read = reading({ documentKind: 'receipt', payment: { method: 'card', cardLast4: '6776' }, totals: { total: 214 } })
    expect(focusDecision(makeItem({ extracted_data: read, payment_card_known: true })).evidence).toMatchObject({ cardLast4: '6776', cardKnown: true })
    // Unknown, or not checked (an older list): shown as read, never as fact.
    expect(focusDecision(makeItem({ extracted_data: read, payment_card_known: false })).evidence).toMatchObject({ cardKnown: false })
    expect(focusDecision(makeItem({ extracted_data: read })).evidence).toMatchObject({ cardKnown: false })
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
      kind: 'bank_match', transactionId: 'tx-1', date: '2026-10-02', amount: -1250, currency: 'SEK', counterparty: 'Leverantören AB', basis: 'rule_ocr_reference', level: 'exakt', cardAgrees: false,
    })
  })

  it('says the card agreed when the card raised the level, or stood in for the name', () => {
    const x = { ...MATCH, amount: -83, counterparty: 'X CORP. PAID FEATURES K3667', basis: 'rule_amount_date' as const }
    const invoice = makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }) })
    const receipt = makeItem({ id: 'receipt', extracted_data: reading({ documentKind: 'receipt', payment: { method: 'card', cardLast4: '3667' } }) })
    // Stark on the amount and date: only the card raises it there.
    expect(focusDecision(invoice, { bankMatch: { ...x, evidence_level: 'stark' } }).evidence).toMatchObject({ cardAgrees: true })
    // Trolig with the receipt's card on the row: the card stood in for the name.
    expect(focusDecision(invoice, { bankMatch: { ...x, evidence_level: 'trolig' }, companion: receipt }).evidence).toMatchObject({ cardAgrees: true })
    // A receipt's own card.
    expect(focusDecision(receipt, { bankMatch: { ...x, evidence_level: 'trolig' } }).evidence).toMatchObject({ cardAgrees: true })
    // No card known, or another basis: the card says nothing.
    expect(focusDecision(invoice, { bankMatch: { ...x, evidence_level: 'trolig' } }).evidence).toMatchObject({ cardAgrees: false })
    expect(focusDecision(invoice, { bankMatch: { ...x, basis: 'rule_ocr_reference', evidence_level: 'exakt' }, companion: receipt }).evidence).toMatchObject({ cardAgrees: false })
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
  const TODAY = '2026-10-20'
  const TO_PAY = { kind: 'to_pay', dueDate: '2026-10-31', overdue: false }

  it('says an invoice with a due date is to be paid, while nothing says it is paid', () => {
    expect(rowStatus(invoice(), undefined, TODAY)).toEqual(TO_PAY)
    expect(rowStatus(invoice(), null, TODAY)).toEqual(TO_PAY)
  })

  // crm#1569: two invoices due 15 Sep looked the same on 31 Oct as one due 19 Nov.
  it('says an invoice past its due date is overdue, the day after the due date and not before', () => {
    const due = (dueDate: string, total: number | null = 29625) =>
      makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate }, totals: { total } }) })
    expect(rowStatus(due('2026-09-15'), null, '2026-10-31')).toEqual({ kind: 'to_pay', dueDate: '2026-09-15', overdue: true })
    expect(rowStatus(due('2026-11-19', 11250), null, '2026-10-31')).toEqual({ kind: 'to_pay', dueDate: '2026-11-19', overdue: false })
    expect(rowStatus(due('2026-10-31'), null, '2026-10-31')).toMatchObject({ overdue: false })
    expect(rowStatus(due('2026-10-30'), null, '2026-10-31')).toMatchObject({ overdue: true })
    // An amount not read yet is still owed, as "Att betala" already says.
    expect(rowStatus(due('2026-09-15', null), null, '2026-10-31')).toMatchObject({ overdue: true })
    // Nothing to pay: nothing falls due.
    expect(rowStatus(due('2026-09-15', 0), null, '2026-10-31')).toMatchObject({ overdue: false })
    // The due date is read as the extraction's other readers read it; one it cannot read is shown as written, never overdue.
    expect(rowStatus(due('15/9/2026'), null, '2026-10-31')).toEqual({ kind: 'to_pay', dueDate: '2026-09-15', overdue: true })
    expect(rowStatus(due('2026-09-15T00:00:00'), null, '2026-10-31')).toEqual({ kind: 'to_pay', dueDate: '2026-09-15', overdue: true })
    expect(rowStatus(due('snart'), null, '2026-10-31')).toEqual({ kind: 'to_pay', dueDate: 'snart', overdue: false })
  })

  it('never calls an invoice overdue when the reading says nothing is left to pay', () => {
    // Settled from an account balance before this payment: total 7.75, applied 7.75, amount due 0.00.
    const prepaid = makeItem({
      extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-01' }, totals: { total: 7.75, prepaidAmount: 7.75 } }),
    })
    expect(rowStatus(prepaid, null, '2026-10-31')).toMatchObject({ overdue: false })
    // Partly settled before: what is left still falls due.
    const partly = makeItem({
      extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-01' }, totals: { total: 100, prepaidAmount: 40 } }),
    })
    expect(rowStatus(partly, null, '2026-10-31')).toMatchObject({ overdue: true })
    // Paid at the till by card: the document is the proof, nothing falls due.
    const card = makeItem({
      extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-10-01' }, totals: { total: 99 }, payment: { method: 'card', cardLast4: null } }),
    })
    expect(rowStatus(card, null, '2026-10-31')).toMatchObject({ overdue: false })
  })

  it('says the opened invoice fell due on the same rule as its row in the list', () => {
    const item = makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice', invoice: { dueDate: '2026-09-15' }, totals: { total: 29625 } }) })
    expect(focusDecision(item, { today: '2026-10-31' }).evidence).toEqual({ kind: 'due', date: '2026-09-15', overdue: true })
    expect(focusDecision(item, { today: '2026-09-15' }).evidence).toEqual({ kind: 'due', date: '2026-09-15', overdue: false })
    expect(rowStatus(item, null, '2026-10-31')).toMatchObject({ overdue: true })
  })

  it('says it looks paid once the bank row it looks paid by is known', () => {
    expect(rowStatus(invoice(), MATCH)).toEqual({ kind: 'looks_paid' })
    expect(rowStatus(makeItem({ extracted_data: reading({ documentKind: 'receipt' }) }), MATCH)).toEqual({ kind: 'looks_paid' })
  })

  it('says it looks paid from the first sight, off the match the list read carries', () => {
    expect(rowStatus({ ...invoice(), bank_match: MATCH })).toEqual({ kind: 'looks_paid' })
    expect(rowStatus({ ...invoice(), bank_match: null }, undefined, TODAY)).toEqual(TO_PAY)
  })

  it('lets a later read win over the list: the focus view found the row booked since, or found one', () => {
    expect(rowStatus({ ...invoice(), bank_match: MATCH }, null, TODAY)).toEqual(TO_PAY)
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

describe('focusDecision: an invoice its receipt says is paid', () => {
  // The X subscription (prod, company Arcim): invoice and receipt in one mail.
  const invoice = makeItem({
    id: 'invoice',
    extracted_data: reading({
      documentKind: 'supplier_invoice',
      supplier: { name: 'X Corp.' },
      invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', dueDate: '2026-10-03' },
      totals: { total: 83 },
    }),
    pairing: { role: 'invoice', receipt_item_id: 'receipt', basis: 'invoice_number' },
  })
  const receipt = makeItem({
    id: 'receipt',
    extracted_data: reading({ documentKind: 'receipt', totals: { total: 83 }, payment: { method: 'card', cardLast4: '3667' } }),
    pairing: { role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' },
  })
  const MATCH = {
    transaction_id: 'tx-x',
    date: '2026-10-05',
    amount: -83,
    currency: 'SEK',
    counterparty: 'X CORP. PAID FEATURES K3667',
    basis: 'rule_amount_date' as const,
    evidence_level: 'stark' as const,
  }

  it('asks who paid, with the receipt\'s card as the evidence, instead of how it will be paid', () => {
    const d = focusDecision(invoice, { companion: receipt })
    expect(d.question).toBe('who_paid')
    expect(d.evidence).toEqual({ kind: 'paid_with', method: 'card', cardLast4: '3667', cardKnown: false })
    expect(focusDecision(invoice, { companion: { ...receipt, payment_card_known: true } }).evidence).toMatchObject({ cardKnown: true })
    expect(d.actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
    // Never "register it unpaid" or "pay it in the bank": the receipt says it is paid.
    expect(d.actions).not.toContain('register_invoice')
    expect(d.actions).not.toContain('pay_in_bank')
    expect(d.editorEscape).toBe(true)
  })

  it('without the receipt\'s row in the list, the invoice\'s amount is the evidence', () => {
    expect(focusDecision(invoice).evidence).toEqual({ kind: 'amount', amount: 83, currency: 'SEK', date: '2026-10-03' })
  })

  it('with a bank row found: settle against it; the third answer is who else paid, never "not paid"', () => {
    const d = focusDecision(invoice, { companion: receipt, bankMatch: MATCH })
    expect(d.question).toBe('already_paid')
    expect(d.actions).toEqual(['register_and_settle', 'match_purchase', 'expense'])
    const off = focusDecision(invoice, { companion: receipt, bankMatch: MATCH, startable: { ...ALL_STARTABLE, supplierInvoices: false, cashMethod: true } })
    expect(off.actions).toEqual(['accept_bank_match', 'match_purchase', 'expense'])
    expect(off.actions).not.toContain('wait_for_payment')
  })

  it('follows what the company can start for the private answer', () => {
    const sole = { ...ALL_STARTABLE, expenses: false, soleTrader: true }
    expect(focusDecision(invoice, { companion: receipt, startable: sole }).actions).toEqual(['match_purchase', 'owner_paid', 'not_underlag'])
    const ab = { ...ALL_STARTABLE, expenses: false }
    expect(focusDecision(invoice, { companion: receipt, startable: ab }).actions).toEqual(['match_purchase', 'turn_on_expenses', 'not_underlag'])
  })

  it('a pair matched to a bank row books like any matched purchase', () => {
    expect(focusDecision({ ...invoice, matched_transaction_id: 'tx-x' }, { companion: receipt }).question).toBe('book_purchase')
  })

  it('an invoice without a pairing still asks how it will be paid', () => {
    expect(focusDecision({ ...invoice, pairing: null }).question).toBe('invoice_paid')
  })

  it('the row says paid by its receipt, not "to pay"', () => {
    expect(rowStatus(invoice, null)).toEqual({ kind: 'paid_by_receipt' })
    expect(rowStatus(invoice, MATCH)).toEqual({ kind: 'looks_paid' })
    expect(rowStatus({ ...invoice, pairing: null }, null, '2026-10-01')).toEqual({ kind: 'to_pay', dueDate: '2026-10-03', overdue: false })
  })
})

describe('focusDecision: the other half of the purchase is booked already', () => {
  const pairing = { role: 'booked_companion' as const, booked_item_id: 'receipt', booked_kind: 'receipt' as const, basis: 'invoice_number' as const, journal_entry_id: 'je-41', voucher: 'A41', locked: false }

  it('asks nothing about paying or booking: its one answer adds it to that verifikat', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }), pairing }))
    expect(d.question).toBe('already_booked_with')
    expect(d.evidence).toEqual({ kind: 'booked_with', bookedKind: 'receipt', voucher: 'A41', locked: false })
    expect(d.actions).toEqual(['attach_to_booking'])
    expect(d.quietActions).toEqual([])
    expect(d.editorEscape).toBe(false)
  })

  it('a locked verifikat takes nothing: the answer is to open it, and the evidence says why', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }), pairing: { ...pairing, locked: true } }))
    expect(d.actions).toEqual(['open_booked_entry'])
    expect(d.evidence).toMatchObject({ kind: 'booked_with', locked: true })
  })

  it('outranks a bank row it looks paid by: the purchase is booked already', () => {
    const match = { transaction_id: 'tx-1', date: '2026-10-02', amount: -20, currency: 'USD', counterparty: 'RESEND', basis: 'rule_amount_date' as const, evidence_level: 'trolig' as const }
    const item = makeItem({ extracted_data: reading({ documentKind: 'supplier_invoice' }), pairing })
    expect(focusDecision(item, { bankMatch: match }).question).toBe('already_booked_with')
    expect(rowStatus(item, match)).toEqual({ kind: 'booked_with', voucher: 'A41' })
  })
})

// PH 101: a receipt dropped in Dokument was filed in the Inkorg before its reading, and only a failed reading
// offered "Läs igen", so a company that can read documents had no way to read it short of uploading it again.
describe('focusDecision: a document nobody read', () => {
  it('offers to read it first where the company can read documents, with who paid one click away', () => {
    const d = focusDecision(makeItem({ kind_hint: 'receipt' }), { canRead: true })
    expect(d.question).toBe('not_read')
    expect(d.evidence).toEqual({ kind: 'not_read' })
    expect(d.actions).toEqual(['retry_reading', 'match_purchase', 'expense'])
    expect(d.quietActions).toEqual(['not_underlag'])
    expect(d.actions.length).toBeLessThanOrEqual(MAX_DECISION_ACTIONS)
  })

  it('counts the empty reading (only the default currency) as nothing read', () => {
    expect(focusDecision(makeItem({ extracted_data: reading() }), { canRead: true }).question).toBe('not_read')
  })

  it('keeps asking who paid where the company cannot read documents: reading is not offered without the capability', () => {
    const d = focusDecision(makeItem({ kind_hint: 'receipt' }))
    expect(d.question).toBe('who_paid')
    expect(d.actions).not.toContain('retry_reading')
    expect(focusDecision(makeItem({ kind_hint: 'receipt' }), { canRead: false }).actions).not.toContain('retry_reading')
  })

  it('asks who paid as before once anything was read', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ totals: { total: 99 } }) }), { canRead: true })
    expect(d.question).toBe('who_paid')
    expect(d.actions).not.toContain('retry_reading')
  })

  it('needs a document to read: a mail with no attachment is never offered a reading', () => {
    expect(focusDecision(makeItem({ document_id: null }), { canRead: true }).question).toBe('who_paid')
  })

  it('follows the switched-off packages for who paid', () => {
    const d = focusDecision(makeItem(), { canRead: true, startable: { ...ALL_STARTABLE, expenses: false, soleTrader: true } })
    expect(d.actions).toEqual(['retry_reading', 'match_purchase', 'owner_paid'])
  })

  it('leaves the failed, linked and booked stages as they were', () => {
    expect(focusDecision(makeItem({ status: 'error' }), { canRead: true }).question).toBe('unreadable')
    expect(focusDecision(makeItem({ matched_transaction_id: 'tx-1' }), { canRead: true }).question).toBe('book_purchase')
    expect(focusDecision(makeItem({ created_journal_entry_id: 'je-1' }), { canRead: true }).question).toBe('booked')
    expect(focusDecision(makeItem({ status: 'processing' }), { canRead: true }).question).toBe('reading')
  })
})

// 2026-10-26: a Bedrock outage left readings empty, and the Inkorg said "Dokumentet är inte läst" with no hint
// that the AI service was down or that the sweep reads it again.
describe('focusDecision: a reading the AI provider could not take', () => {
  it.each(['scheduled', 'scheduled_later', 'exhausted'] as const)('carries the retry (%s) on the not-read evidence, reading first', (retry) => {
    const d = focusDecision(makeItem({ extracted_data: reading(), reading_retry: retry }), { canRead: true })
    expect(d.question).toBe('not_read')
    expect(d.evidence).toEqual({ kind: 'not_read', retry })
    expect(d.actions[0]).toBe('retry_reading')
    expect(d.actions).toEqual(['retry_reading', 'match_purchase', 'expense'])
    expect(d.quietActions).toEqual(['not_underlag'])
  })

  it('keeps the plain not-read evidence when the reading did not fail at the provider', () => {
    expect(focusDecision(makeItem({ reading_retry: null }), { canRead: true }).evidence).toEqual({ kind: 'not_read' })
  })

  it('never says so once something was read, or where the company cannot read documents', () => {
    const read = focusDecision(makeItem({ extracted_data: reading({ totals: { total: 99 } }), reading_retry: 'scheduled' }), { canRead: true })
    expect(read.question).toBe('who_paid')
    const noAi = focusDecision(makeItem({ reading_retry: 'scheduled' }), { canRead: false })
    expect(noAi.evidence).not.toEqual(expect.objectContaining({ retry: 'scheduled' }))
  })
})

describe('nothingRead', () => {
  it('is true for no reading and for the empty skeleton, false once one value was read', () => {
    expect(nothingRead(null)).toBe(true)
    expect(nothingRead(reading())).toBe(true)
    expect(nothingRead(reading({ supplier: { name: 'ICA' } }))).toBe(false)
    expect(nothingRead(reading({ invoice: { invoiceDate: '2026-10-01' } }))).toBe(false)
    expect(nothingRead(reading({ prominentAmounts: [{ amount: 0 }] as never }))).toBe(true)
    expect(nothingRead(reading({ prominentAmounts: [{ amount: 45 }] as never }))).toBe(false)
  })
})

// crm#1799: an agency's unpaid invoice, uploaded and read as a letter, asked "Vem betalade?" with the company
// account, an utlägg or removal as its only answers: nothing said nobody had paid it yet.
describe('focusDecision: who paid a document not read as an invoice', () => {
  it.each(['government_letter', 'other'] as const)('offers "nobody yet" as the third answer for a %s, removal as the quiet link', (documentKind) => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind, totals: { total: 500 } }) }))
    expect(d.question).toBe('who_paid')
    expect(d.actions).toEqual(['match_purchase', 'expense', 'register_invoice'])
    expect(d.quietActions).toEqual(['not_underlag'])
    expect(d.editorEscape).toBe(true)
  })

  it('offers it for a document whose kind nobody could tell', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ totals: { total: 99 } }) }))
    expect(d.actions).toEqual(['match_purchase', 'expense', 'register_invoice'])
  })

  it('keeps a receipt as it was, with the invoice road as a quiet link for a reading that got it wrong', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'receipt', totals: { total: 120 } }) }))
    expect(d.actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
    expect(d.quietActions).toEqual(['register_invoice'])
  })

  it('never offers it without Leverantörsfakturor: the server would refuse', () => {
    const off: InkorgStartable = { ...ALL_STARTABLE, supplierInvoices: false }
    for (const documentKind of ['government_letter', 'receipt'] as const) {
      const d = focusDecision(makeItem({ extracted_data: reading({ documentKind, totals: { total: 500 } }) }), { startable: off })
      expect(d.actions).toEqual(['match_purchase', 'expense', 'not_underlag'])
      expect(d.quietActions).toEqual([])
    }
  })

  it('never offers it for the receipt half of a pair: it follows its invoice', () => {
    const d = focusDecision(
      makeItem({ extracted_data: reading({ documentKind: 'receipt', totals: { total: 120 } }), pairing: { role: 'receipt', invoice_item_id: 'inv-1', basis: 'invoice_number' } }),
    )
    expect(d.actions).not.toContain('register_invoice')
    expect(d.quietActions).toEqual([])
  })

  it('stays within three answers', () => {
    const d = focusDecision(makeItem({ extracted_data: reading({ documentKind: 'government_letter' }) }))
    expect(d.actions.length).toBeLessThanOrEqual(MAX_DECISION_ACTIONS)
  })
})
