import { describe, expect, it } from 'vitest'
import {
  bannerCheckLine,
  bannerCheckNeedsLook,
  bannerStep,
  bannerUnpaid,
  batchItemFor,
  daysBetween,
  overdueBanner,
  sendLabelKey,
} from '../overdue-banner'
import type { EntryCase } from '../invoice-entry'
import { bankCandidate, bankView, readinessView } from './readiness-fixtures'

const TODAY = '2026-10-09'
const overdue = { status: 'sent', due_date: '2026-09-02', remaining_amount: 12500 }

function banner(overrides: Partial<Parameters<typeof overdueBanner>[0]> = {}) {
  return overdueBanner({
    invoice: overdue,
    start: 'ready',
    openCase: null,
    today: TODAY,
    canWrite: true,
    canManage: true,
    defaultStartStep: 'reminder',
    ...overrides,
  })
}

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-02', TODAY)).toBe(37)
    expect(daysBetween('2026-10-08', TODAY)).toBe(1)
  })

  it('is 0 for a missing, equal or later date', () => {
    expect(daysBetween(null, TODAY)).toBe(0)
    expect(daysBetween(TODAY, TODAY)).toBe(0)
    expect(daysBetween('2026-10-20', TODAY)).toBe(0)
  })
})

describe('overdueBanner', () => {
  it('shows nothing while collections is hidden: no screen changes with the flags off', () => {
    expect(banner({ start: 'hidden' })).toBeNull()
  })

  it('shows nothing for an invoice that is not owed and overdue', () => {
    expect(banner({ invoice: { ...overdue, due_date: '2026-10-09' } })).toBeNull()
    expect(banner({ invoice: { ...overdue, status: 'paid' } })).toBeNull()
    expect(banner({ invoice: { ...overdue, status: 'draft' } })).toBeNull()
    expect(banner({ invoice: { ...overdue, remaining_amount: 0 } })).toBeNull()
  })

  it('shows nothing to a viewer', () => {
    expect(banner({ canWrite: false })).toBeNull()
  })

  it('gives way to an open case (the case card shows instead)', () => {
    const open: EntryCase = { stage: 'reminder', isOpen: true, submissionStatus: 'registered', actions: ['pause'] }
    expect(banner({ openCase: open })).toBeNull()
  })

  it('offers sending with when it fell due and how long ago', () => {
    expect(banner()).toEqual({
      kind: 'ready',
      dueDate: '2026-09-02',
      overdueDays: 37,
      step: 'reminder',
      labelKey: 'banner_send_reminder',
    })
  })

  it('names the configured first step on the button', () => {
    expect(banner({ defaultStartStep: 'collection' })).toMatchObject({ step: 'collection', labelKey: 'banner_send_collection' })
  })

  it('follows the facts once read: a watched claim starts with a reminder', () => {
    const watched = readinessView({ watching: true, defaultStartStep: 'collection' })
    expect(banner({ defaultStartStep: 'collection', readiness: watched })).toMatchObject({ step: 'reminder' })
  })

  it('offers activation to owners and admins and says who can to others', () => {
    expect(banner({ start: 'activate' })).toMatchObject({ kind: 'activate', canActivate: true })
    expect(banner({ start: 'activate', canManage: false })).toMatchObject({ kind: 'activate', canActivate: false })
  })

  it('shows the upgrade note without the paid plan', () => {
    expect(banner({ start: 'upgrade' })).toMatchObject({ kind: 'upgrade', overdueDays: 37 })
  })
})

describe('bannerStep and sendLabelKey', () => {
  it('falls back to a reminder, the activation default', () => {
    expect(bannerStep(null, undefined)).toBe('reminder')
  })

  it('uses the default the provider offers, else the first offered', () => {
    expect(bannerStep('reminder', readinessView({ defaultStartStep: 'collection' }))).toBe('collection')
    expect(bannerStep('reminder', readinessView({ defaultStartStep: 'collection', startSteps: ['reminder'] }))).toBe('reminder')
  })

  it('labels each step', () => {
    expect(sendLabelKey('reminder')).toBe('banner_send_reminder')
    expect(sendLabelKey('collection')).toBe('banner_send_collection')
  })
})

describe('bannerCheckLine', () => {
  it('reads loading and unavailable', () => {
    expect(bannerCheckLine(undefined)).toEqual({ key: 'banner_bank_checking' })
    expect(bannerCheckLine(null)).toEqual({ key: 'banner_bank_unavailable' })
  })

  it('says there is no payment in the bank, with when it was synced', () => {
    expect(bannerCheckLine(readinessView())).toEqual({ key: 'banner_bank_clear', date: '2026-10-06T06:00:00.000Z' })
  })

  it('counts the unbooked rows that may be the payment, leaving out the dismissed', () => {
    const r = readinessView({ bankCheck: bankView({ candidates: [bankCandidate('a'), bankCandidate('b', true), bankCandidate('c')] }) })
    expect(bannerCheckLine(r)).toEqual({ key: 'banner_bank_candidates', count: 2 })
  })

  it('asks for a look when the bank is stale or not connected', () => {
    const stale = readinessView({
      bankCheck: bankView({
        freshness: 'stale',
        accounts: [{ name: 'Konto', ledgerAccount: '1930', syncedAt: '2026-09-30T06:00:00.000Z', fresh: false, connected: true }],
      }),
    })
    expect(bannerCheckLine(stale)).toEqual({ key: 'banner_bank_stale', date: '2026-09-30T06:00:00.000Z' })
    expect(bannerCheckLine(readinessView({ bankCheck: bankView({ freshness: 'no_bank', accounts: [] }) }))).toEqual({ key: 'banner_bank_no_bank' })
  })

  it('reads a failed requirement first', () => {
    const block = { code: 'elig_below_minimum' as const, params: { amount: 100 } }
    expect(bannerCheckLine(readinessView({ eligible: false, blocks: [block] }))).toEqual({ key: 'banner_blocked', block })
  })

  it('tones only the lines that ask the person to look', () => {
    expect(bannerCheckNeedsLook({ key: 'banner_bank_clear', date: null })).toBe(false)
    expect(bannerCheckNeedsLook({ key: 'banner_bank_checking' })).toBe(false)
    expect(bannerCheckNeedsLook({ key: 'banner_bank_candidates', count: 1 })).toBe(true)
    expect(bannerCheckNeedsLook({ key: 'banner_bank_no_bank' })).toBe(true)
  })
})

describe('bannerUnpaid', () => {
  it('prefers the checked claim, then the invoice', () => {
    expect(bannerUnpaid({ remaining_amount: 900 }, readinessView({ claim: { amount: 1250, vatAmount: 250, remaining: 1000 } }))).toBe(1000)
    expect(bannerUnpaid({ remaining_amount: 900 }, undefined)).toBe(900)
    expect(bannerUnpaid({ remaining_amount: null, total: 1250 }, null)).toBe(1250)
    expect(bannerUnpaid({}, null)).toBeNull()
  })
})

describe('an invoice in today\'s run', () => {
  const INVOICE = 'inv-1'
  const run = [
    { kind: 'open' as const, invoice_id: INVOICE, start_step: 'collection' as const },
    { kind: 'approve_step' as const, invoice_id: 'inv-2', start_step: null },
  ]

  it('finds the run item that would send this invoice, never a step to approve', () => {
    expect(batchItemFor(run, INVOICE)).toEqual(run[0])
    expect(batchItemFor(run, 'inv-2')).toBeNull()
    expect(batchItemFor(null, INVOICE)).toBeNull()
  })

  it('points to the run instead of offering a send of its own', () => {
    expect(banner({ batchItem: run[0] })).toMatchObject({ kind: 'batch', step: 'collection', labelKey: 'banner_in_batch_collection' })
    expect(banner({ batchItem: { kind: 'start', start_step: 'reminder' } })).toMatchObject({ kind: 'batch', labelKey: 'banner_in_batch_reminder' })
  })

  it('keeps the activation and upgrade notes, which come before any run', () => {
    expect(banner({ start: 'upgrade', batchItem: run[0] })).toMatchObject({ kind: 'upgrade' })
    expect(banner({ start: 'activate', batchItem: run[0] })).toMatchObject({ kind: 'activate' })
  })
})
