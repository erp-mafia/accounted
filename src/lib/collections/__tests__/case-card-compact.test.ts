/**
 * The compact case card at the top of the invoice (inkasso lives on the
 * invoice): where it sits, its one chip, the amounts in owner words, and the
 * Händelser list collapsed to the latest event.
 */
import { describe, expect, it } from 'vitest'
import { caseAmounts, casePlacement, caseStageChip, caseTimeline, eventShowsTime } from '../case-card'

const registered = { isOpen: true, submissionStatus: 'registered' as const }

describe('casePlacement', () => {
  it('puts an open case at the top and a closed one with the history', () => {
    expect(casePlacement({ isOpen: true })).toBe('top')
    expect(casePlacement({ isOpen: false })).toBe('history')
  })
})

describe('caseStageChip', () => {
  it('shows the stage in its own words, in the list chip variant', () => {
    expect(caseStageChip({ ...registered, stage: 'collection' })).toEqual({ labelKey: 'stage_collection', variant: 'secondary' })
    expect(caseStageChip({ ...registered, stage: 'awaiting_decision' })).toEqual({ labelKey: 'stage_awaiting_decision', variant: 'warning' })
    expect(caseStageChip({ ...registered, stage: 'paused' })).toEqual({ labelKey: 'stage_paused', variant: 'outline' })
  })

  it('shows no chip for a closed case or one not registered yet', () => {
    expect(caseStageChip({ ...registered, isOpen: false, stage: 'closed_paid' })).toBeNull()
    expect(caseStageChip({ isOpen: true, submissionStatus: 'submitted', stage: 'registered' })).toBeNull()
  })
})

describe('caseAmounts', () => {
  it('reads what is unpaid and, when larger, what the customer must pay including fees', () => {
    expect(caseAmounts({ isOpen: true, outstandingPrincipal: 12500, outstandingTotal: 12680 })).toEqual({ unpaid: 12500, customerTotal: 12680 })
  })

  it('leaves the total out when it adds nothing', () => {
    expect(caseAmounts({ isOpen: true, outstandingPrincipal: 12500, outstandingTotal: 12500 })).toEqual({ unpaid: 12500, customerTotal: null })
    expect(caseAmounts({ isOpen: true, outstandingPrincipal: null, outstandingTotal: null })).toEqual({ unpaid: null, customerTotal: null })
  })

  it('shows no amounts for a closed case', () => {
    expect(caseAmounts({ isOpen: false, outstandingPrincipal: 0, outstandingTotal: 0 })).toEqual({ unpaid: null, customerTotal: null })
  })
})

describe('caseTimeline', () => {
  const events = ['newest', 'middle', 'oldest']

  it('shows the latest event alone until asked', () => {
    expect(caseTimeline(events, false)).toEqual({ shown: ['newest'], hidden: 2 })
  })

  it('shows all of them on request', () => {
    expect(caseTimeline(events, true)).toEqual({ shown: events, hidden: 0 })
  })

  it('has nothing to hide with one or no event', () => {
    expect(caseTimeline(['only'], false)).toEqual({ shown: ['only'], hidden: 0 })
    expect(caseTimeline([], false)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('eventShowsTime', () => {
  it('shows the time of a provider event, so two events on one day read in order', () => {
    expect(eventShowsTime({ occurredAt: '2026-10-09T08:14:03.000Z', labelKey: null })).toBe(true)
    expect(eventShowsTime({ occurredAt: '2026-10-09T10:14:03+02:00', labelKey: 'event_action_pause' })).toBe(true)
  })

  it('shows the date alone where no real time is known', () => {
    expect(eventShowsTime({ occurredAt: '2026-10-09T12:00:00.000Z', labelKey: 'event_collected' })).toBe(false)
    expect(eventShowsTime({ occurredAt: '2026-10-09T00:00:00Z', labelKey: null })).toBe(false)
    expect(eventShowsTime({ occurredAt: '2026-10-09T00:00:00.000+00:00', labelKey: null })).toBe(false)
    expect(eventShowsTime({ occurredAt: '2026-10-09', labelKey: null })).toBe(false)
  })
})
