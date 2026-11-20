import { describe, expect, it } from 'vitest'
import {
  attestMailStanding,
  attestReminderSlot,
  attestRoundReady,
  planAttestFollowUps,
  planAttestRequests,
  type AttestMailCompany,
  type AttestMailInvoice,
  type AttestMailState,
} from '../attest-mail-plan'
import type { AttestationRecord, AttestPolicy } from '../attest-policy'

/**
 * The rules of the batched attest mail (crm#1569), built from the byrå case
 * behind the ticket: the byrå registers the client's invoices, the client
 * attests them, the byrå pays. Kim is the client and the only attester; Alex
 * is the byrå's bookkeeper who registers.
 */

const POLICY: AttestPolicy = {
  enabled: true,
  threshold_amount: 1000,
  mode: 'any',
  attesters: ['kim', 'robin'],
  preparer_may_attest: false,
  two_step_from_sek: null,
  updated_by: null,
  updated_at: null,
}

function company(overrides: Partial<AttestMailCompany> = {}): AttestMailCompany {
  return {
    policy: POLICY,
    accountingMethod: 'accrual',
    attesters: new Set(['alex', 'kim', 'robin']),
    limits: new Map(),
    attestations: new Map(),
    optedOut: new Set(),
    ...overrides,
  }
}

const invoice = (id: string, overrides: Partial<AttestMailInvoice> = {}): AttestMailInvoice => ({
  id,
  user_id: 'alex',
  status: 'registered',
  approved_at: null,
  is_credit_note: false,
  currency: 'SEK',
  total: 29625,
  total_sek: null,
  exchange_rate: null,
  due_date: '2026-11-19',
  ...overrides,
})

const STATE: AttestMailState = {
  asked_at: '2026-10-31T09:00:00Z',
  reminded_early_at: null,
  reminded_last_at: null,
  overdue_told_at: null,
  blocked_told_at: null,
}

describe('attestRoundReady: one mail per round of registrations', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()

  it('waits while the company is still registering, then sends 15 minutes after the latest one', () => {
    expect(attestRoundReady([minutesAgo(40), minutesAgo(10)], now)).toBe(false)
    expect(attestRoundReady([minutesAgo(40), minutesAgo(15)], now)).toBe(true)
    expect(attestRoundReady([], now)).toBe(false)
  })

  it('still sends once the oldest queued invoice has waited two hours, however busy the company is', () => {
    expect(attestRoundReady([minutesAgo(119), minutesAgo(1)], now)).toBe(false)
    expect(attestRoundReady([minutesAgo(120), minutesAgo(1)], now)).toBe(true)
  })
})

describe('planAttestRequests: one mail per attester listing every invoice waiting on them', () => {
  it('asks each attester once about all the invoices of the round, soonest due first', () => {
    const plan = planAttestRequests(company(), [invoice('kb', { due_date: '2026-11-19' }), invoice('mf-1', { due_date: '2026-11-05' })])
    expect(plan.asks).toEqual(
      new Map([
        ['kim', ['mf-1', 'kb']],
        ['robin', ['mf-1', 'kb']],
      ]),
    )
    expect(plan.blocked).toEqual([])
  })

  it('leaves out whoever switched the mail off, and invoices the policy does not govern or that left attest', () => {
    const plan = planAttestRequests(company({ optedOut: new Set(['robin']) }), [
      invoice('waiting'),
      invoice('small', { total: 999 }),
      invoice('attested', { approved_at: '2026-10-31T10:00:00Z' }),
      invoice('paid', { status: 'paid' }),
      invoice('credit', { is_credit_note: true }),
    ])
    expect(plan.asks).toEqual(new Map([['kim', ['waiting']]]))
    expect(planAttestRequests(company({ accountingMethod: 'cash' }), [invoice('waiting')]).asks.size).toBe(0)
    expect(planAttestRequests(company({ policy: { ...POLICY, enabled: false } }), [invoice('waiting')]).asks.size).toBe(0)
  })

  it('tells the registrant instead when nobody can attest: the client registered it and is the only attester', () => {
    const onlyKim = company({ policy: { ...POLICY, attesters: ['kim'] } })
    const plan = planAttestRequests(onlyKim, [invoice('by-kim', { user_id: 'kim' }), invoice('by-alex')])
    expect(plan.blocked).toEqual(['by-kim'])
    expect(plan.asks).toEqual(new Map([['kim', ['by-alex']]]))
    // With "Den som registrerar får också attestera" on, the client is asked about it too.
    const mayAttestOwn = company({ policy: { ...POLICY, attesters: ['kim'], preparer_may_attest: true } })
    expect(planAttestRequests(mayAttestOwn, [invoice('by-kim', { user_id: 'kim' })]).asks).toEqual(new Map([['kim', ['by-kim']]]))
  })

  it('asks nobody again about an invoice whose latest decision is a rejection: it waits on the registrant', () => {
    const rejected: AttestationRecord[] = [{ user_id: 'kim', decision: 'rejected', decided_at: '2026-10-31T10:00:00Z', comment: 'Fel belopp' }]
    const plan = planAttestRequests(company({ attestations: new Map([['mf-1', rejected]]) }), [invoice('mf-1')])
    expect(plan.asks.size).toBe(0)
    expect(plan.blocked).toEqual([])
    expect(attestMailStanding(company({ attestations: new Map([['mf-1', rejected]]) }), invoice('mf-1'))).toEqual({ kind: 'rejected' })
  })

  it('asks only the attesters still missing under mode all', () => {
    const kimApproved: AttestationRecord[] = [{ user_id: 'kim', decision: 'approved', decided_at: '2026-10-31T10:00:00Z' }]
    const all = company({ policy: { ...POLICY, mode: 'all' }, attestations: new Map([['mf-1', kimApproved]]) })
    expect(planAttestRequests(all, [invoice('mf-1')]).asks).toEqual(new Map([['robin', ['mf-1']]]))
  })
})

describe('reminders before the due date', () => {
  it('reminds 3 days before and the day before, or the day after a missed one, each once, never on the day of the request', () => {
    const today = '2026-10-31'
    const asked = '2026-10-20'
    expect(attestReminderSlot('2026-11-04', today, STATE, asked)).toBeNull()
    expect(attestReminderSlot('2026-11-03', today, STATE, asked)).toBe('early')
    expect(attestReminderSlot('2026-11-02', today, STATE, asked)).toBe('early')
    expect(attestReminderSlot('2026-11-01', today, STATE, asked)).toBe('last')
    expect(attestReminderSlot('2026-10-31', today, STATE, asked)).toBe('last')
    expect(attestReminderSlot('2026-10-30', today, STATE, asked)).toBeNull()
    expect(attestReminderSlot('2026-11-03', today, { ...STATE, reminded_early_at: '2026-10-30T06:15:00Z' }, asked)).toBeNull()
    expect(attestReminderSlot('2026-11-01', today, { ...STATE, reminded_last_at: '2026-10-31T06:15:00Z' }, asked)).toBeNull()
    expect(attestReminderSlot('2026-11-01', today, STATE, today)).toBeNull()
    expect(attestReminderSlot('2026-11-01', today, { ...STATE, asked_at: null }, null)).toBeNull()
  })

  it('does not catch up a reminder whose day the request itself fell on: asked 3 days before the due date, the next mail is the day before', () => {
    const askedOn = '2026-10-31'
    const asked = { ...STATE, asked_at: '2026-10-31T09:00:00Z' }
    expect(attestReminderSlot('2026-11-03', '2026-11-01', asked, askedOn)).toBeNull()
    expect(attestReminderSlot('2026-11-03', '2026-11-02', asked, askedOn)).toBe('last')
    // Asked the day before the due date: that request is the last word.
    expect(attestReminderSlot('2026-11-01', '2026-11-01', asked, askedOn)).toBeNull()
  })
})

describe('planAttestFollowUps: the daily job', () => {
  const today = '2026-10-31'
  const row = (inv: AttestMailInvoice, state: Partial<AttestMailState> = {}) => ({ invoice: inv, state: { ...STATE, ...state }, askedOn: '2026-10-20' })

  it('reminds the attesters about what falls due soon, one list per attester', () => {
    const plan = planAttestFollowUps(
      company({ optedOut: new Set(['robin']) }),
      [row(invoice('soon', { due_date: '2026-11-03' })), row(invoice('tomorrow', { due_date: '2026-11-01' })), row(invoice('later', { due_date: '2026-11-19' }))],
      today,
    )
    expect(plan.reminders).toEqual(new Map([['kim', ['tomorrow', 'soon']]]))
    // The slots are used up for everyone, also those who switched the mail off.
    expect(plan.slots).toEqual({ early: ['soon'], last: ['tomorrow'] })
  })

  it('tells the registrant once when a due date passes after the attester was asked', () => {
    const plan = planAttestFollowUps(
      company(),
      [
        row(invoice('passed', { due_date: '2026-10-25', status: 'overdue' })),
        row(invoice('told', { due_date: '2026-10-25', status: 'overdue' }), { overdue_told_at: '2026-10-26T06:15:00Z' }),
      ],
      today,
    )
    expect(plan.overdue).toEqual(['passed'])
    expect(plan.reminders.size).toBe(0)
  })

  it('says nothing about an invoice that was already overdue when it was asked for (the case behind the ticket: due 15 Sep, registered 31 Oct)', () => {
    const askedLate = { invoice: invoice('mf-1', { due_date: '2026-09-15', status: 'overdue' }), state: { ...STATE, asked_at: '2026-10-31T12:00:00Z' }, askedOn: '2026-10-31' }
    expect(planAttestFollowUps(company(), [askedLate], '2026-11-01').overdue).toEqual([])
    // Due the day it was asked: that due date passes after the ask.
    const dueThatDay = { ...askedLate, invoice: invoice('mf-2', { due_date: '2026-10-31', status: 'overdue' }) }
    expect(planAttestFollowUps(company(), [dueThatDay], '2026-11-01').overdue).toEqual(['mf-2'])
  })

  it('tells the registrant once when nobody can attest any more, and leaves rejected and attested invoices alone', () => {
    const onlyKim = company({
      policy: { ...POLICY, attesters: ['kim'] },
      attestations: new Map([['rejected', [{ user_id: 'kim', decision: 'rejected', decided_at: '2026-10-30T10:00:00Z' } as AttestationRecord]]]),
    })
    const plan = planAttestFollowUps(
      onlyKim,
      [
        row(invoice('by-kim', { user_id: 'kim', due_date: '2026-11-01' })),
        row(invoice('told', { user_id: 'kim', due_date: '2026-11-01' }), { blocked_told_at: '2026-10-30T06:15:00Z' }),
        row(invoice('rejected', { due_date: '2026-09-15', status: 'overdue' })),
        row(invoice('attested', { due_date: '2026-11-01', approved_at: '2026-10-30T10:00:00Z' })),
      ],
      today,
    )
    expect(plan.blocked).toEqual(['by-kim'])
    expect(plan.overdue).toEqual([])
    expect(plan.reminders.size).toBe(0)
    expect(plan.slots).toEqual({ early: [], last: [] })
  })
})
