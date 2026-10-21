import { describe, expect, it } from 'vitest'
import { collectionsActionSchema } from '@accounted/connect-contract'
import {
  actionDialogSpec,
  caseActionBody,
  caseCardButtons,
  caseNotes,
  escalationAllows,
  escalationGate,
  messageLongEnough,
  pauseUntilProblem,
  type CardDialogAction,
} from '../case-card'
import type { BankCheckView, CaseEscalationCheckView } from '../invoice-collection'

const openCase = { isOpen: true, submissionStatus: 'registered' as const }

const answers = {
  message: '',
  until: '',
  bankAttested: false,
  dismissed: [] as string[],
  feeShown: false,
}

function bank(overrides: Partial<BankCheckView> = {}): BankCheckView {
  return { outcome: 'pass', freshness: 'fresh', lastSyncedAt: null, accounts: [], candidates: [], ...overrides }
}

function escalation(overrides: Partial<CaseEscalationCheckView> = {}): CaseEscalationCheckView {
  return { remaining: 1250, providerOutstanding: 1250, refusal: null, bankCheck: bank(), ...overrides }
}

describe('caseCardButtons', () => {
  it('shows only what the snapshot offers, the waiting decision first', () => {
    const buttons = caseCardButtons({ ...openCase, actions: ['withdraw', 'pause', 'approve_step'] }, true)
    expect(buttons.map((b) => b.action)).toEqual(['approve_step', 'pause', 'withdraw'])
    expect(buttons[0]).toMatchObject({ kind: 'dialog', primary: true, labelKey: 'action_approve' })
    expect(buttons[2]).toMatchObject({ primary: false })
  })

  it('opens the handover dialog for start and leaves "already paid" to the page header', () => {
    const buttons = caseCardButtons({ ...openCase, actions: ['already_paid', 'start'] }, true)
    expect(buttons.map((b) => [b.action, b.kind])).toEqual([['start', 'handover']])
  })

  it('shows nothing to a reader, for a case being registered, or for a closed case', () => {
    expect(caseCardButtons({ ...openCase, actions: ['pause'] }, false)).toEqual([])
    expect(caseCardButtons({ isOpen: true, submissionStatus: 'submitted', actions: ['pause'] }, true)).toEqual([])
    expect(caseCardButtons({ isOpen: false, submissionStatus: 'registered', actions: ['pause'] }, true)).toEqual([])
  })

  it('has a button for every contract action but "already paid", which the page header carries', () => {
    const all = caseCardButtons({ ...openCase, actions: [...collectionsActionSchema.options] }, true)
    expect(all.map((b) => b.action).sort()).toEqual(collectionsActionSchema.options.filter((a) => a !== 'already_paid').sort())
  })
})

describe('actionDialogSpec', () => {
  const ctx = { decisionKind: null, withdrawFeeMayApply: false }

  it('gives every dialog action a title, a body and a confirm', () => {
    const actions = collectionsActionSchema.options.filter((a): a is CardDialogAction => a !== 'start' && a !== 'already_paid')
    for (const action of actions) {
      const spec = actionDialogSpec(action, ctx)
      expect(spec.titleKey).toBeTruthy()
      expect(spec.bodyKeys.length).toBeGreaterThan(0)
      expect(spec.confirmKey).toBeTruthy()
    }
  })

  it('names the step an approval lets through, and the legal fee of a collection notice', () => {
    expect(actionDialogSpec('approve_step', { ...ctx, decisionKind: 'approve_reminder' })).toMatchObject({
      titleKey: 'approve_reminder_title',
      bodyKeys: ['approve_body'],
      escalation: true,
    })
    expect(actionDialogSpec('approve_step', { ...ctx, decisionKind: 'approve_collection_notice' }).bodyKeys).toEqual([
      'approve_body',
      'approve_notice_fee',
    ])
  })

  it('checks the books and the bank for the escalations only', () => {
    expect(actionDialogSpec('confirm_not_paid', ctx).escalation).toBe(true)
    expect(actionDialogSpec('pause', ctx).escalation).toBe(false)
    expect(actionDialogSpec('contest_dispute', ctx).escalation).toBe(false)
  })

  it('asks for a reason for a dispute and for "not paid"', () => {
    expect(actionDialogSpec('dispute', ctx).message).toEqual({ labelKey: 'dispute_field', min: 10 })
    expect(actionDialogSpec('confirm_not_paid', ctx).message).toEqual({ labelKey: null, min: 10 })
    expect(actionDialogSpec('withdraw', ctx).message).toBeNull()
  })

  it('shows the withdraw fee line once the free days have passed', () => {
    expect(actionDialogSpec('withdraw', ctx)).toMatchObject({ bodyKeys: ['withdraw_body'], feeLine: false, destructive: true })
    expect(actionDialogSpec('withdraw', { ...ctx, withdrawFeeMayApply: true })).toMatchObject({
      bodyKeys: ['withdraw_body', 'withdraw_fee'],
      feeLine: true,
    })
  })

  it('offers the until date on a pause only', () => {
    expect(actionDialogSpec('pause', ctx).until).toBe(true)
    expect(actionDialogSpec('resume', ctx).until).toBe(false)
  })
})

describe('messageLongEnough', () => {
  it('counts trimmed characters', () => {
    const spec = actionDialogSpec('dispute', { decisionKind: null, withdrawFeeMayApply: false })
    expect(messageLongEnough(spec, '   kort   ')).toBe(false)
    expect(messageLongEnough(spec, 'Varan kom aldrig fram')).toBe(true)
    expect(messageLongEnough(actionDialogSpec('pause', { decisionKind: null, withdrawFeeMayApply: false }), '')).toBe(true)
  })
})

describe('pauseUntilProblem', () => {
  it('takes an empty date as a pause until resumed', () => {
    expect(pauseUntilProblem('', '2026-10-06')).toBeNull()
  })

  it('needs a date after today and at most 14 days ahead', () => {
    expect(pauseUntilProblem('2026-10-06', '2026-10-06')).toBe('pause_until_after_today')
    expect(pauseUntilProblem('2026-10-07', '2026-10-06')).toBeNull()
    expect(pauseUntilProblem('2026-10-20', '2026-10-06')).toBeNull()
    expect(pauseUntilProblem('2026-10-21', '2026-10-06')).toBe('pause_until_too_far')
  })
})

describe('escalationGate', () => {
  it('waits for the click-time check, and lets the commit decide when it could not be read', () => {
    expect(escalationGate(undefined, [])).toEqual({ state: 'loading' })
    expect(escalationAllows(escalationGate(undefined, []), true)).toBe(false)
    expect(escalationAllows(escalationGate(null, []), false)).toBe(true)
  })

  it('goes ahead when the books and a fresh bank agree', () => {
    const gate = escalationGate(escalation(), [])
    expect(gate.state).toBe('ok')
    expect(escalationAllows(gate, false)).toBe(true)
  })

  it('stops a paid invoice', () => {
    const gate = escalationGate(escalation({ remaining: 0, refusal: { code: 'COLLECTION_NOT_ELIGIBLE' } }), [])
    expect(gate.state).toBe('paid')
    expect(escalationAllows(gate, true)).toBe(false)
  })

  it('stops while the provider has not heard of a payment in the books', () => {
    const gate = escalationGate(escalation({ remaining: 750, providerOutstanding: 1250 }), [])
    expect(gate).toEqual({ state: 'not_reported', remaining: 750, providerOutstanding: 1250 })
    expect(escalationAllows(gate, true)).toBe(false)
  })

  it('stops on an unbooked bank row until it is dismissed', () => {
    const row = { transactionId: 't1', date: '2026-10-01', amount: 1250, description: 'Kund AB', reason: 'name' as const, dismissed: false }
    const e = escalation({ bankCheck: bank({ outcome: 'candidates', candidates: [row] }) })
    expect(escalationGate(e, []).state).toBe('candidates')
    expect(escalationGate(e, ['t1']).state).toBe('ok')
  })

  it('asks for the attestation when the bank is not fresh', () => {
    const gate = escalationGate(escalation({ bankCheck: bank({ outcome: 'stale', freshness: 'stale' }) }), [])
    expect(gate.state).toBe('attest')
    expect(escalationAllows(gate, false)).toBe(false)
    expect(escalationAllows(gate, true)).toBe(true)
  })
})

describe('caseActionBody', () => {
  const ctx = { decisionKind: null, withdrawFeeMayApply: false }

  it('sends a pause with its date, and without one when left empty', () => {
    const spec = actionDialogSpec('pause', ctx)
    expect(caseActionBody('pause', spec, { ...answers, until: '2026-11-01' })).toEqual({ action: 'pause', until: '2026-11-01' })
    expect(caseActionBody('pause', spec, answers)).toEqual({ action: 'pause' })
  })

  it('acknowledges the withdraw fee only when the line was shown', () => {
    const shown = actionDialogSpec('withdraw', { ...ctx, withdrawFeeMayApply: true })
    expect(caseActionBody('withdraw', shown, { ...answers, feeShown: true })).toEqual({ action: 'withdraw', fee_acknowledged: true })
    expect(caseActionBody('withdraw', actionDialogSpec('withdraw', ctx), answers)).toEqual({ action: 'withdraw' })
  })

  it('sends the bank attestation and dismissed rows with an escalation only', () => {
    const withBank = { ...answers, message: '  Kollat banken i dag  ', bankAttested: true, dismissed: ['t1'] }
    expect(caseActionBody('confirm_not_paid', actionDialogSpec('confirm_not_paid', ctx), withBank)).toEqual({
      action: 'confirm_not_paid',
      message: 'Kollat banken i dag',
      bank_attested: true,
      dismissed_transaction_ids: ['t1'],
    })
    expect(caseActionBody('resume', actionDialogSpec('resume', ctx), { ...answers, bankAttested: true, dismissed: ['t1'] })).toEqual({
      action: 'resume',
    })
  })
})

describe('caseNotes', () => {
  const view = {
    isOpen: true,
    submissionStatus: 'registered' as const,
    stage: 'reminder' as const,
    pausedBySweep: false,
    pauseReason: null,
    possiblePayments: [],
  }
  const possible = { id: 'h1', transactionId: 't1', date: '2026-10-05', amount: 100, reason: 'reference' as const, pauseState: 'paused' as const }

  it('says a registered claim has not been started', () => {
    expect(caseNotes({ ...view, stage: 'registered' }, 'overdue')).toEqual(['card_not_started'])
  })

  it('says the provider closes a case whose invoice is paid', () => {
    expect(caseNotes({ ...view, stage: 'registered' }, 'paid')).toEqual(['card_paid_closing'])
    expect(caseNotes(view, 'paid')).toEqual(['card_paid_closing'])
  })

  it('names a pause by the bank sweep, and nothing for a closed case', () => {
    const paused = { ...view, pausedBySweep: true, pauseReason: 'possible_payment' as const }
    expect(caseNotes({ ...paused, possiblePayments: [possible] }, 'overdue')).toEqual(['card_paused_possible_payment'])
    // Every bank row answered: the case waits for the person to resume it.
    expect(caseNotes(paused, 'overdue')).toEqual(['card_paused_possible_payment_answered'])
    expect(caseNotes({ ...paused, isOpen: false }, 'paid')).toEqual([])
  })

  it('names a pause by the reconcile', () => {
    expect(caseNotes({ ...view, pausedBySweep: true, pauseReason: 'outstanding_mismatch' }, 'overdue')).toEqual(['card_paused_mismatch'])
  })
})
