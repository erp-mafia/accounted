/**
 * The collected-payments readout and the trail labels (case.ts): what the
 * customer paid the provider itself is read out once per payment, never the
 * payments the ledger reported; ledger-written trail rows carry a message
 * key, the provider's own rows do not; a closed case ends the automatic pause.
 */
import { describe, expect, it } from 'vitest'
import type { CollectionsCase } from '@accounted/connect-contract'
import { applyCaseSnapshot, eventLabelKey, normalizeCaseRow, snapshotCasePatch, snapshotEvents } from '../case'
import { createMemorySupabase } from './memory-supabase'

const snapshot = (overrides: Partial<CollectionsCase> = {}): CollectionsCase => ({
  caseRef: 'c-1',
  caseNumber: '17',
  invoiceRef: 'inv-1',
  stage: 'reminder',
  isOpen: true,
  closeReason: null,
  decisionKind: null,
  providerState: 'X',
  providerStateLabel: 'Påminnelse',
  outstandingPrincipal: 1000,
  outstandingTotal: 1060,
  currency: 'SEK',
  nextActionDate: null,
  nextActionLabel: null,
  actions: ['pause'],
  parentCaseRef: null,
  events: [],
  collectedPayments: [],
  reportedPayments: [],
  documents: [],
  updatedAt: '2026-10-06T08:00:00Z',
  raw: {},
  ...overrides,
})

describe('snapshotEvents: the collected payments readout', () => {
  it('reads out each payment to the provider once, with what reduced the claim', () => {
    const events = snapshotEvents(
      snapshot({
        collectedPayments: [
          { paymentRef: 'p-1', paidAt: '2026-10-05', total: 1100, capitalPaid: 1000, toCreditorOther: 40, toAgency: 60 },
          { paymentRef: 'p-2', paidAt: '2026-10-06', total: 0, capitalPaid: 0, toCreditorOther: 0, toAgency: 0 },
        ],
        reportedPayments: [{ paymentRef: 'ours', amount: 200, matchedAmount: 200, date: '2026-10-01' }],
      }),
    )
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'payment',
        label: 'collected',
        direction: 'from_debtor',
        amount: 1100,
        providerEventRef: 'collected:p-1',
        occurredAt: '2026-10-05T12:00:00.000Z',
        raw: { capital_paid: 1000, to_creditor_other: 40, to_agency: 60 },
      }),
    ])
  })
})

describe('eventLabelKey', () => {
  it('keys the rows the ledger writes and leaves the provider rows as written', () => {
    expect(eventLabelKey({ kind: 'user_action', label: 'pause', provider_event_ref: null })).toBe('event_action_pause')
    expect(eventLabelKey({ kind: 'payment_forwarded', label: 'reported', provider_event_ref: 'forward:x:reported' })).toBe(
      'event_forward_payment_forwarded_reported',
    )
    expect(eventLabelKey({ kind: 'possible_payment', label: 'paused', provider_event_ref: 'sweep:h' })).toBe('event_possible_payment_paused')
    expect(eventLabelKey({ kind: 'payment', label: 'collected', provider_event_ref: 'collected:p-1' })).toBe('event_collected')
    expect(eventLabelKey({ kind: 'other', label: 'mismatch_paused', provider_event_ref: 'reconcile:c:t:mismatch_paused' })).toBe(
      'event_reconcile_mismatch_paused',
    )
    expect(eventLabelKey({ kind: 'letter', label: 'Påminnelse skickad', provider_event_ref: 'ev-9' })).toBeNull()
  })
})

describe('snapshotCasePatch', () => {
  it('ends the automatic pause and the mismatch when the provider closes the case', () => {
    const row = normalizeCaseRow({
      id: 'case-1',
      stage: 'paused',
      is_open: true,
      claim_amount: 1000,
      paused_by_sweep: true,
      pause_reason: 'possible_payment',
      outstanding_mismatch: 10,
      provider_case_ref: 'c-1',
    })
    expect(snapshotCasePatch(row, snapshot({ stage: 'closed_paid', isOpen: false, closeReason: 'paid' }), new Date())).toMatchObject({
      paused_by_sweep: false,
      pause_reason: null,
      outstanding_mismatch: null,
    })
    expect(snapshotCasePatch(row, snapshot(), new Date())).not.toHaveProperty('paused_by_sweep')
  })
})

describe('applyCaseSnapshot: collected payments are kept for their booking', () => {
  it('stores each payment with capital the provider collected itself, once, as pending', async () => {
    const mem = createMemorySupabase()
    mem.seed('collection_cases', [{ id: 'case-1', company_id: 'company-1', invoice_id: 'invoice-1', stage: 'reminder', is_open: true, opened_by: null }])
    const row = normalizeCaseRow(mem.rows('collection_cases')[0]!)
    const collected = snapshot({
      collectedPayments: [{ paymentRef: 'p-1', paidAt: '2026-10-05', total: 1060, capitalPaid: 1000, toCreditorOther: 0, toAgency: 60 }],
      reportedPayments: [{ paymentRef: 'ours', amount: 200, matchedAmount: 200, date: '2026-10-04' }],
    })
    await applyCaseSnapshot(mem.client, row, collected)
    await applyCaseSnapshot(mem.client, row, collected)
    expect(mem.rows('collection_collected_payments')).toEqual([
      expect.objectContaining({ case_id: 'case-1', invoice_id: 'invoice-1', provider_payment_ref: 'p-1', capital_paid: 1000, to_agency: 60 }),
    ])
  })
})
