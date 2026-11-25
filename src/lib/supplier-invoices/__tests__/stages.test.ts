import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { PAYMENT_ORDER_STATUSES, paymentOrderWaitsFor } from '@/lib/payments/orders/status'
import {
  bankEnteredHolds,
  countByStage,
  deriveStage,
  hasOpenBankPaymentOrder,
  openPaymentMarker,
  OPEN_PAYMENT_MARKER_LABEL_KEYS,
  stageIndex,
  stagesFor,
  SUPPLIER_INVOICE_STAGES,
} from '../stages'

const base = { status: 'registered', approved_at: null, is_credit_note: false, in_open_batch: false, reconciled: false }
/** A company with an attest step: faktureringsmetoden with the attest policy on. */
const attesting = { ...base, accounting_method: 'accrual', attest_policy_on: true }

describe('supplier invoice stages', () => {
  it('walks the ladder from registered to reconciled', () => {
    expect(deriveStage(attesting)).toBe('registered')
    expect(deriveStage({ ...attesting, status: 'overdue' })).toBe('registered')
    expect(deriveStage({ ...attesting, approved_at: '2026-09-06T10:00:00Z' })).toBe('approved')
    expect(deriveStage({ ...attesting, status: 'approved' })).toBe('approved')
    expect(deriveStage({ ...attesting, approved_at: '2026-09-06T10:00:00Z', in_open_batch: true })).toBe('in_file')
    expect(deriveStage({ ...attesting, status: 'paid', approved_at: '2026-09-06T10:00:00Z' })).toBe('paid')
    expect(deriveStage({ ...attesting, status: 'paid', reconciled: true })).toBe('reconciled')
  })

  it('takes credit notes and credited invoices off the ladder', () => {
    expect(deriveStage({ ...base, is_credit_note: true })).toBe('credited')
    expect(deriveStage({ ...base, status: 'credited' })).toBe('credited')
    expect(deriveStage({ ...base, status: 'reversed', approved_at: 'x' })).toBe('credited')
    expect(stageIndex('credited')).toBe(-1)
  })

  it('a paid invoice still in an old batch reads as paid, not in file', () => {
    expect(deriveStage({ ...base, status: 'paid', in_open_batch: true })).toBe('paid')
  })

  it('only faktureringsmetoden with the attest policy on has the attest step', () => {
    const withoutAttest = ['incoming', 'registered', 'in_file', 'paid', 'reconciled']
    expect(stagesFor('cash', true)).toEqual(withoutAttest)
    expect(stagesFor('cash', false)).toEqual(withoutAttest)
    expect(stagesFor('accrual', true)).toEqual([...SUPPLIER_INVOICE_STAGES])
    expect(stagesFor(null, true)).toEqual([...SUPPLIER_INVOICE_STAGES])
    expect(stagesFor('accrual', false)).toEqual(withoutAttest)
    expect(stagesFor('accrual', undefined)).toEqual(withoutAttest)
  })

  // #93: an attest on a kontantmetod invoice (from before a switch of method,
  // or given through the API) pointed at a step the cash ladder skips, so the
  // flow strip showed no current step.
  it('keeps an attested kontantmetod invoice on its own ladder', () => {
    const cash = { ...base, accounting_method: 'cash', attest_policy_on: true }
    for (const attested of [{ approved_at: '2026-09-06T10:00:00Z' }, { status: 'approved' }, { status: 'overdue', approved_at: 'x' }]) {
      const stage = deriveStage({ ...cash, ...attested })
      expect(stage).toBe('registered')
      expect(stagesFor('cash', true)).toContain(stage)
    }
    // The later steps are the same on both ladders.
    expect(deriveStage({ ...cash, status: 'approved', in_open_batch: true })).toBe('in_file')
    expect(deriveStage({ ...cash, status: 'paid', approved_at: 'x', reconciled: true })).toBe('reconciled')
    // Faktureringsmetoden with the policy on, and a caller that does not say the method, still attest.
    expect(deriveStage({ ...base, accounting_method: 'accrual', attest_policy_on: true, status: 'approved' })).toBe('approved')
    expect(deriveStage({ ...base, accounting_method: null, attest_policy_on: true, status: 'approved' })).toBe('approved')
  })

  // An attest given where the company has no policy on (before this rule, or
  // through the API) keeps its mark, but the ladder has no step for it.
  it('keeps an attested invoice of a company without an attest policy on its own ladder', () => {
    const noPolicy = { ...base, accounting_method: 'accrual', attest_policy_on: false }
    for (const attested of [{ approved_at: '2026-09-06T10:00:00Z' }, { status: 'approved' }, { status: 'overdue', approved_at: 'x' }]) {
      const stage = deriveStage({ ...noPolicy, ...attested })
      expect(stage).toBe('registered')
      expect(stagesFor('accrual', false)).toContain(stage)
    }
    expect(deriveStage({ ...noPolicy, in_open_batch: true })).toBe('in_file')
    expect(deriveStage({ ...base, accounting_method: 'accrual', status: 'approved' })).toBe('registered')
  })

  it('always answers a step on the company ladder (or credited)', () => {
    const statuses = ['registered', 'approved', 'overdue', 'partially_paid', 'disputed', 'paid']
    for (const accounting_method of ['cash', 'accrual'] as const) {
      for (const attest_policy_on of [true, false]) {
        for (const status of statuses) {
          for (const approved_at of [null, '2026-09-06T10:00:00Z']) {
            for (const in_open_batch of [false, true]) {
              const stage = deriveStage({ ...base, accounting_method, attest_policy_on, status, approved_at, in_open_batch })
              expect(stagesFor(accounting_method, attest_policy_on)).toContain(stage)
            }
          }
        }
      }
    }
  })

  it('counts invoices per stage', () => {
    const counts = countByStage([
      { stage: 'registered', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
      { stage: 'registered', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
      { stage: 'paid', approved_at: null, batch: null, payment_order: null, paid: null, reconciled_through: null },
    ])
    expect(counts.registered).toBe(2)
    expect(counts.paid).toBe(1)
    expect(counts.reconciled).toBe(0)
  })
})

describe('openPaymentMarker (crm#1243)', () => {
  const order = { id: 'order-1', status: 'accepted', created_at: '2026-10-15T13:54:35Z', provider_status: 'ACSP', provider_error_code: null }
  const batch = { id: 'batch-1', created_at: '2026-10-01T08:00:00Z' }

  it('marks an unsettled invoice a bank payment covers, before a file', () => {
    expect(openPaymentMarker({ status: 'registered', open_payment: { batch: null, payment_order: order } })).toBe('bank_payment')
    expect(openPaymentMarker({ status: 'overdue', open_payment: { batch, payment_order: order } })).toBe('bank_payment')
    expect(openPaymentMarker({ status: 'approved', open_payment: { batch, payment_order: null } })).toBe('payment_file')
    expect(openPaymentMarker({ status: 'partially_paid', open_payment: { batch, payment_order: null } })).toBe('payment_file')
  })

  it('says nothing when nothing covers the invoice', () => {
    expect(openPaymentMarker({ status: 'registered' })).toBeNull()
    expect(openPaymentMarker({ status: 'registered', open_payment: null })).toBeNull()
    expect(openPaymentMarker({ status: 'approved', open_payment: { batch: null, payment_order: null } })).toBeNull()
  })

  it('says nothing on a settled invoice or a credit note, whatever still points at it', () => {
    for (const status of ['paid', 'credited', 'reversed']) {
      expect(openPaymentMarker({ status, open_payment: { batch, payment_order: order } })).toBeNull()
    }
    expect(openPaymentMarker({ status: 'registered', is_credit_note: true, open_payment: { batch, payment_order: order } })).toBeNull()
  })
})

describe('a bank payment that waits for a person is a marker of its own (crm#1925)', () => {
  const orderIn = (status: string) => ({ id: 'order-1', status, created_at: '2026-11-09T10:12:00Z', provider_status: null, provider_error_code: null })
  const invoiceWith = (status: string) => ({ status: 'approved', open_payment: { batch: null, payment_order: orderIn(status) } })

  it('reads an order nobody has approved or signed as unsigned, not as in payment', () => {
    // Prepared by an agent: a draft until a person approves and signs it.
    expect(openPaymentMarker(invoiceWith('draft'))).toBe('bank_payment_unsigned')
    // Approved, or back from a BankID that ended unsigned.
    expect(openPaymentMarker(invoiceWith('approved'))).toBe('bank_payment_unsigned')
  })

  it('reads an order that has gone to the bank as in payment, as before', () => {
    for (const status of ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']) {
      expect(openPaymentMarker(invoiceWith(status))).toBe('bank_payment')
    }
  })

  it('asks the one rule: unsigned exactly when the order waits for a person, for every status', () => {
    for (const status of PAYMENT_ORDER_STATUSES) {
      expect(openPaymentMarker(invoiceWith(status)) === 'bank_payment_unsigned').toBe(paymentOrderWaitsFor({ status }) !== null)
    }
  })

  it('still wins over a tick and a file, and still says nothing on a settled invoice', () => {
    const batch = { id: 'batch-1', created_at: '2026-11-01T08:00:00Z' }
    const ticked = { status: 'approved', bank_entered_at: '2026-11-10T09:00:00Z', due_date: '2026-11-30', remaining_amount: 12500 }
    expect(openPaymentMarker({ ...ticked, open_payment: { batch, payment_order: orderIn('draft') } }, '2026-11-12')).toBe('bank_payment_unsigned')
    expect(openPaymentMarker({ status: 'paid', open_payment: { batch: null, payment_order: orderIn('draft') } })).toBeNull()
  })

  it('counts as an open bank payment order either way: no new payment of the invoice is offered', () => {
    expect(hasOpenBankPaymentOrder('bank_payment')).toBe(true)
    expect(hasOpenBankPaymentOrder('bank_payment_unsigned')).toBe(true)
    expect(hasOpenBankPaymentOrder('bank_entered')).toBe(false)
    expect(hasOpenBankPaymentOrder('payment_file')).toBe(false)
    expect(hasOpenBankPaymentOrder(null)).toBe(false)
  })

  it('has its own chip words in both languages, as every marker has', () => {
    for (const key of Object.values(OPEN_PAYMENT_MARKER_LABEL_KEYS)) {
      expect(sv.supplier_invoices).toHaveProperty(key)
      expect(en.supplier_invoices).toHaveProperty(key)
    }
    expect(OPEN_PAYMENT_MARKER_LABEL_KEYS.bank_payment_unsigned).not.toBe(OPEN_PAYMENT_MARKER_LABEL_KEYS.bank_payment)
    expect(sv.supplier_invoices.bank_payment_unsigned_chip).toBe('Väntar på signering')
  })
})

describe('the "Inlagd i banken" tick as a payment under way (crm#1824)', () => {
  const TODAY = '2026-11-12'
  const order = { id: 'order-1', status: 'accepted', created_at: '2026-11-10T13:54:35Z', provider_status: 'ACSP', provider_error_code: null }
  const batch = { id: 'batch-1', created_at: '2026-11-01T08:00:00Z' }
  // 12 500 kr due 30 Nov, ticked on 10 Nov.
  const ticked = { status: 'approved', bank_entered_at: '2026-11-10T09:00:00Z', due_date: '2026-11-30', remaining_amount: 12500 }

  it('marks a ticked invoice that has not fallen due, the due date itself included', () => {
    expect(openPaymentMarker(ticked, TODAY)).toBe('bank_entered')
    expect(openPaymentMarker({ ...ticked, due_date: TODAY }, TODAY)).toBe('bank_entered')
    expect(openPaymentMarker({ ...ticked, status: 'partially_paid', remaining_amount: 2500 }, TODAY)).toBe('bank_entered')
    expect(openPaymentMarker({ ...ticked, status: 'registered' }, TODAY)).toBe('bank_entered')
  })

  it('lets go of the tick once the invoice has fallen due and is still unpaid', () => {
    // The day after the due date, before the nightly flip has stored 'overdue'.
    expect(openPaymentMarker({ ...ticked, due_date: '2026-11-11' }, TODAY)).toBeNull()
    // Stored as overdue by the flip.
    expect(openPaymentMarker({ ...ticked, status: 'overdue', due_date: '2026-11-01' }, TODAY)).toBeNull()
    // A part-paid invoice is never flipped to 'overdue': the date decides.
    expect(openPaymentMarker({ ...ticked, status: 'partially_paid', remaining_amount: 2500, due_date: '2026-11-01' }, TODAY)).toBeNull()
    // A file under the lapsed tick is what is left to say.
    expect(openPaymentMarker({ ...ticked, due_date: '2026-11-01', open_payment: { batch, payment_order: null } }, TODAY)).toBe('payment_file')
  })

  it('reads a real bank payment order before the tick, and the tick before a file', () => {
    expect(openPaymentMarker({ ...ticked, open_payment: { batch: null, payment_order: order } }, TODAY)).toBe('bank_payment')
    // The order holds past the due date; the tick does not.
    expect(openPaymentMarker({ ...ticked, status: 'overdue', due_date: '2026-11-01', open_payment: { batch: null, payment_order: order } }, TODAY)).toBe('bank_payment')
    expect(openPaymentMarker({ ...ticked, open_payment: { batch, payment_order: null } }, TODAY)).toBe('bank_entered')
  })

  it('says nothing once the tick is taken back, on a settled invoice or on a credit note', () => {
    expect(openPaymentMarker({ ...ticked, bank_entered_at: null }, TODAY)).toBeNull()
    expect(openPaymentMarker({ ...ticked, status: 'paid', remaining_amount: 0 }, TODAY)).toBeNull()
    expect(openPaymentMarker({ ...ticked, is_credit_note: true }, TODAY)).toBeNull()
  })

  it('answers the same question for the to-pay counts (bankEnteredHolds)', () => {
    expect(bankEnteredHolds(ticked, TODAY)).toBe(true)
    expect(bankEnteredHolds({ ...ticked, due_date: '2026-11-11' }, TODAY)).toBe(false)
    expect(bankEnteredHolds({ ...ticked, bank_entered_at: null }, TODAY)).toBe(false)
    // Nothing left to pay is not a debt that has fallen due (isOverduePayable).
    expect(bankEnteredHolds({ ...ticked, due_date: '2026-11-01', remaining_amount: 0.004 }, TODAY)).toBe(true)
    // A reader that did not fetch the due date or the amount: the stored status decides.
    expect(bankEnteredHolds({ status: 'approved', bank_entered_at: ticked.bank_entered_at }, TODAY)).toBe(true)
    expect(bankEnteredHolds({ status: 'approved', bank_entered_at: ticked.bank_entered_at, due_date: '2026-11-01' }, TODAY)).toBe(false)
    expect(bankEnteredHolds({ status: 'overdue', bank_entered_at: ticked.bank_entered_at }, TODAY)).toBe(false)
  })
})
