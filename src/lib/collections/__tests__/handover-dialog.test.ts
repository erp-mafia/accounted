import { describe, expect, it } from 'vitest'
import {
  bankCheckState,
  handoverCanSend,
  handoverReloadsAfter,
  handoverRequestBody,
  handoverWording,
  initialStartStep,
  offeredStartSteps,
  toggleDismissed,
  type HandoverAnswers,
} from '../handover-dialog'
import type { BankCheckView, CollectionReadinessView } from '../invoice-collection'

function bank(overrides: Partial<BankCheckView> = {}): BankCheckView {
  return {
    outcome: 'pass',
    freshness: 'fresh',
    lastSyncedAt: '2026-10-06T06:00:00.000Z',
    accounts: [{ name: 'Företagskonto', ledgerAccount: '1930', syncedAt: '2026-10-06T06:00:00.000Z', fresh: true, connected: true }],
    candidates: [],
    ...overrides,
  }
}

const candidate = (id: string, dismissed = false) => ({
  transactionId: id,
  date: '2026-10-01',
  amount: 500,
  description: 'Inbetalning',
  reason: 'name' as const,
  dismissed,
})

function readiness(overrides: Partial<CollectionReadinessView> = {}): CollectionReadinessView {
  return {
    eligible: true,
    blocks: [],
    hints: [],
    invoiceNumber: '1042',
    dueDate: '2026-09-01',
    overdueDays: 35,
    claim: { amount: 1250, vatAmount: 250, remaining: 1250 },
    rotRut: false,
    customer: { id: 'cust-1', name: 'Kund AB', kind: 'business', missingAddress: [], identity: 'not_needed' },
    deliveryAttestation: null,
    responseAttestation: null,
    reminderFee: { agreed: false, since: null },
    bankCheck: bank(),
    startSteps: ['reminder', 'collection'],
    defaultStartStep: 'reminder',
    minimumAmount: 0,
    watching: false,
    withdrawFreeDays: 14,
    ...overrides,
  }
}

const answers = (overrides: Partial<HandoverAnswers> = {}): HandoverAnswers => ({
  startStep: 'reminder',
  dismissed: [],
  bankAttested: false,
  deliveryAttested: false,
  responseAttested: false,
  ...overrides,
})

describe('bankCheckState', () => {
  it('passes a fresh bank without candidates', () => {
    const state = bankCheckState(bank(), [])
    expect(state).toMatchObject({ outcome: 'pass', needsAttest: false, blocking: [] })
  })

  it('blocks on an unbooked row until the person marks it as something else', () => {
    const b = bank({ outcome: 'candidates', candidates: [candidate('t1'), candidate('t2')] })
    expect(bankCheckState(b, []).outcome).toBe('candidates')
    expect(bankCheckState(b, ['t1']).blocking.map((c) => c.transactionId)).toEqual(['t2'])
    expect(bankCheckState(b, ['t1', 't2']).outcome).toBe('pass')
  })

  it('counts a row the server already knows as dismissed', () => {
    expect(bankCheckState(bank({ candidates: [candidate('t1', true)] }), []).outcome).toBe('pass')
  })

  it('falls back to the freshness once every row is dismissed, and asks for the attestation', () => {
    const b = bank({
      freshness: 'stale',
      candidates: [candidate('t1')],
      accounts: [
        { name: null, ledgerAccount: '1930', syncedAt: '2026-10-01T06:00:00.000Z', fresh: true, connected: true },
        { name: null, ledgerAccount: '1940', syncedAt: '2026-09-20T06:00:00.000Z', fresh: false, connected: true },
      ],
    })
    const state = bankCheckState(b, ['t1'])
    expect(state.outcome).toBe('stale')
    expect(state.needsAttest).toBe(true)
    expect(state.staleAccount).toEqual({ name: '1940', syncedAt: '2026-09-20T06:00:00.000Z' })
  })

  it('asks for the attestation when the payee account is not connected', () => {
    const state = bankCheckState(bank({ freshness: 'no_bank', accounts: [] }), [])
    expect(state).toMatchObject({ outcome: 'no_bank', needsAttest: true, staleAccount: null })
  })
})

describe('toggleDismissed', () => {
  it('adds and removes a row', () => {
    expect(toggleDismissed([], 't1')).toEqual(['t1'])
    expect(toggleDismissed(['t1', 't2'], 't1')).toEqual(['t2'])
  })
})

describe('start steps', () => {
  it('opens on the company default when the provider offers it', () => {
    expect(initialStartStep(readiness({ defaultStartStep: 'collection' }))).toBe('collection')
    expect(initialStartStep(readiness({ defaultStartStep: 'collection', startSteps: ['reminder'] }))).toBe('reminder')
  })

  it('offers no choice for a watched claim', () => {
    expect(offeredStartSteps(readiness({ watching: true }))).toEqual([])
    expect(offeredStartSteps(readiness())).toEqual(['reminder', 'collection'])
  })
})

describe('handoverWording', () => {
  it('follows the chosen first step: a reminder never reads as debt collection', () => {
    expect(handoverWording(readiness(), 'reminder')).toEqual({ title: 'send_title_start', confirm: 'send_confirm_start' })
    expect(handoverWording(readiness(), 'collection')).toEqual({ title: 'send_title', confirm: 'send_confirm' })
  })

  it('reads as a reminder for a watched claim, and stays general until the facts load', () => {
    expect(handoverWording(readiness({ watching: true }), 'collection')).toEqual({ title: 'send_title_start', confirm: 'send_confirm_start' })
    expect(handoverWording(null, 'reminder')).toEqual({ title: 'send_title', confirm: 'send_confirm' })
  })
})

describe('handoverCanSend', () => {
  it('sends an eligible invoice with a clean bank check', () => {
    expect(handoverCanSend(readiness(), answers())).toBe(true)
  })

  it('never sends an ineligible invoice', () => {
    expect(handoverCanSend(readiness({ eligible: false, blocks: [{ code: 'elig_paid' }] }), answers())).toBe(false)
  })

  it('waits for every bank row to be booked or dismissed', () => {
    const r = readiness({ bankCheck: bank({ candidates: [candidate('t1')] }) })
    expect(handoverCanSend(r, answers())).toBe(false)
    expect(handoverCanSend(r, answers({ dismissed: ['t1'] }))).toBe(true)
  })

  it('needs the bank attestation for a stale bank', () => {
    const r = readiness({ bankCheck: bank({ freshness: 'stale' }) })
    expect(handoverCanSend(r, answers())).toBe(false)
    expect(handoverCanSend(r, answers({ bankAttested: true }))).toBe(true)
  })

  it('needs the import, delivery and response attestations the facts call for', () => {
    expect(handoverCanSend(readiness({ deliveryAttestation: 'imported' }), answers())).toBe(false)
    expect(handoverCanSend(readiness({ deliveryAttestation: 'imported' }), answers({ deliveryAttested: true }))).toBe(true)
    expect(handoverCanSend(readiness({ responseAttestation: 'disputed' }), answers())).toBe(false)
    expect(handoverCanSend(readiness({ responseAttestation: 'disputed' }), answers({ responseAttested: true }))).toBe(true)
  })

  it('refuses a start step the provider does not offer', () => {
    expect(handoverCanSend(readiness({ startSteps: ['reminder'] }), answers({ startStep: 'collection' }))).toBe(false)
  })
})

describe('handoverRequestBody', () => {
  it('sends the step and the amount the person saw, and no attestation that was not asked for', () => {
    expect(handoverRequestBody(readiness(), answers({ startStep: 'collection', bankAttested: true, deliveryAttested: true }))).toEqual({
      start_step: 'collection',
      expected_remaining: 1250,
    })
  })

  it('sends the import attestation as imported, the delivery one as delivered', () => {
    expect(handoverRequestBody(readiness({ deliveryAttestation: 'imported' }), answers({ deliveryAttested: true }))).toMatchObject({
      imported_attested: true,
    })
    const delivered = handoverRequestBody(readiness({ deliveryAttestation: 'not_delivered' }), answers({ deliveryAttested: true }))
    expect(delivered).toMatchObject({ delivery_attested: true })
    expect(delivered).not.toHaveProperty('imported_attested')
  })

  it('sends the bank attestation for a stale bank, the response one when asked, and only dismissals of listed rows', () => {
    const r = readiness({ bankCheck: bank({ freshness: 'stale', candidates: [candidate('t1')] }), responseAttestation: 'marked_paid' })
    expect(handoverRequestBody(r, answers({ bankAttested: true, responseAttested: true, dismissed: ['t1', 'gone'] }))).toEqual({
      start_step: 'reminder',
      expected_remaining: 1250,
      bank_attested: true,
      response_attested: true,
      dismissed_transaction_ids: ['t1'],
    })
  })

  it('starts a watched claim with a reminder', () => {
    expect(handoverRequestBody(readiness({ watching: true }), answers({ startStep: 'collection' })).start_step).toBe('reminder')
  })
})

describe('handoverReloadsAfter', () => {
  it('reads the invoice again when its facts changed', () => {
    expect(handoverReloadsAfter('COLLECTION_REMAINING_CHANGED')).toBe(true)
    expect(handoverReloadsAfter('COLLECTION_BANK_CANDIDATES')).toBe(true)
    expect(handoverReloadsAfter('CONNECTOR_UPSTREAM_DISABLED')).toBe(false)
    expect(handoverReloadsAfter(null)).toBe(false)
  })
})
