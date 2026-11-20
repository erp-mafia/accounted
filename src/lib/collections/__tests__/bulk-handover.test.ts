import { describe, expect, it, vi } from 'vitest'
import {
  bulkHoldReason,
  bulkRequestBody,
  bulkRow,
  bulkSendable,
  bulkSummary,
  bulkTitle,
  bulkToSend,
  runBulkSends,
  type BulkOutcome,
  type BulkRow,
} from '../bulk-handover'
import { bankCandidate, bankView, readinessView } from './readiness-fixtures'

const TODAY = '2026-10-09'
const owed = { id: 'inv-1', status: 'sent', due_date: '2026-09-02', remaining_amount: 1250 }

describe('bulkSendable', () => {
  const ctx = { today: TODAY, openCaseIds: new Set<string>() }

  it('lets the person tick an owed invoice past its due date', () => {
    expect(bulkSendable(owed, ctx)).toBe(true)
    expect(bulkSendable({ ...owed, status: 'partially_paid' }, ctx)).toBe(true)
  })

  it('never ticks one not due yet, paid, a credit note, another document or one with an open case', () => {
    expect(bulkSendable({ ...owed, due_date: TODAY }, ctx)).toBe(false)
    expect(bulkSendable({ ...owed, status: 'paid' }, ctx)).toBe(false)
    expect(bulkSendable({ ...owed, remaining_amount: 0 }, ctx)).toBe(false)
    expect(bulkSendable({ ...owed, credited_invoice_id: 'orig' }, ctx)).toBe(false)
    expect(bulkSendable({ ...owed, document_type: 'proforma' }, ctx)).toBe(false)
    expect(bulkSendable(owed, { today: TODAY, openCaseIds: new Set(['inv-1']) })).toBe(false)
  })
})

describe('bulkHoldReason', () => {
  it('lets a clean, eligible invoice go from the list', () => {
    expect(bulkHoldReason(readinessView())).toBeNull()
  })

  it('holds an ineligible invoice with its first requirement', () => {
    const block = { code: 'debtor_missing_address' as const }
    expect(bulkHoldReason(readinessView({ eligible: false, blocks: [block] }))).toEqual({ key: 'bulk_hold_blocked', block })
  })

  it('holds a possible payment in the bank', () => {
    const r = readinessView({ bankCheck: bankView({ candidates: [bankCandidate('a'), bankCandidate('b')] }) })
    expect(bulkHoldReason(r)).toEqual({ key: 'bulk_hold_candidates', count: 2 })
  })

  it('holds what needs a person to attest: a stale bank, delivery, an import, an answer', () => {
    expect(bulkHoldReason(readinessView({ bankCheck: bankView({ freshness: 'stale' }) }))).toEqual({ key: 'bulk_hold_bank' })
    expect(bulkHoldReason(readinessView({ bankCheck: bankView({ freshness: 'no_bank', accounts: [] }) }))).toEqual({ key: 'bulk_hold_bank' })
    expect(bulkHoldReason(readinessView({ deliveryAttestation: 'not_delivered' }))).toEqual({ key: 'bulk_hold_delivery' })
    expect(bulkHoldReason(readinessView({ deliveryAttestation: 'imported' }))).toEqual({ key: 'bulk_hold_imported' })
    expect(bulkHoldReason(readinessView({ responseAttestation: 'disputed' }))).toEqual({ key: 'bulk_hold_response' })
  })

  it('sends the step the provider offers when the default is not one', () => {
    expect(bulkHoldReason(readinessView({ startSteps: ['collection'], defaultStartStep: 'reminder' }))).toBeNull()
    expect(bulkRequestBody(readinessView({ startSteps: ['collection'], defaultStartStep: 'reminder' }))).toMatchObject({ start_step: 'collection' })
  })
})

describe('bulkRow', () => {
  it('loads, then reads sendable with the step and the bank line', () => {
    expect(bulkRow(undefined)).toEqual({ state: 'loading' })
    expect(bulkRow(readinessView({ defaultStartStep: 'collection' }))).toEqual({
      state: 'sendable',
      step: 'collection',
      check: { key: 'banner_bank_clear', date: '2026-10-06T06:00:00.000Z' },
      remaining: 1250,
    })
  })

  it('holds an invoice that could not be read', () => {
    expect(bulkRow(null)).toMatchObject({ state: 'held', reason: { key: 'bulk_hold_unavailable' } })
  })

  it('holds with the reason and keeps the facts for the row', () => {
    expect(bulkRow(readinessView({ responseAttestation: 'marked_paid' }))).toMatchObject({
      state: 'held',
      step: 'reminder',
      remaining: 1250,
      reason: { key: 'bulk_hold_response' },
    })
  })
})

describe('bulkRequestBody', () => {
  it('sends the configured step and the amount seen, and never an attestation', () => {
    expect(bulkRequestBody(readinessView({ defaultStartStep: 'collection' }))).toEqual({ start_step: 'collection', expected_remaining: 1250 })
  })

  it('starts a watched claim with a reminder', () => {
    expect(bulkRequestBody(readinessView({ watching: true }))).toEqual({ start_step: 'reminder', expected_remaining: 1250 })
  })
})

describe('bulkToSend and bulkSummary', () => {
  const sendable: BulkRow = { state: 'sendable', step: 'reminder', check: { key: 'banner_bank_clear', date: null }, remaining: 1 }
  const held: BulkRow = { state: 'held', step: null, check: null, remaining: null, reason: { key: 'bulk_hold_unavailable' } }

  it('sends the sendable rows left ticked, in order', () => {
    const rows = { a: sendable, b: held, c: sendable, d: { state: 'loading' } as BulkRow }
    expect(bulkToSend(['a', 'b', 'c', 'd'], rows, [])).toEqual(['a', 'c'])
    expect(bulkToSend(['a', 'b', 'c', 'd'], rows, ['c'])).toEqual(['a'])
  })

  it('titles the dialog with what the button sends, never the invoices it holds back', () => {
    const rows = { a: sendable, b: held }
    expect(bulkTitle(['a', 'b'], rows, [])).toEqual({ key: 'bulk_title', count: 1 })
    expect(bulkTitle(['a', 'b'], rows, ['a'])).toEqual({ key: 'bulk_title_plain' })
    expect(bulkTitle(['a', 'c'], { a: sendable, c: { state: 'loading' } }, [])).toEqual({ key: 'bulk_title_plain' })
  })

  it('counts sent and failed and says while it runs', () => {
    const outcomes: Record<string, BulkOutcome> = {
      a: { state: 'sent', registered: true },
      b: { state: 'sent', registered: false },
      c: { state: 'failed', message: 'nej' },
    }
    expect(bulkSummary(outcomes)).toEqual({ sent: 2, failed: 1, running: false })
    expect(bulkSummary({ ...outcomes, d: { state: 'sending' } })).toMatchObject({ running: true })
  })
})

describe('runBulkSends', () => {
  it('sends one at a time and reports each invoice', async () => {
    const order: string[] = []
    const send = vi.fn(async (id: string) => {
      order.push(`send:${id}`)
      return id === 'b' ? ({ state: 'failed', message: 'nej' } as const) : ({ state: 'sent', registered: true } as const)
    })
    const seen: Array<[string, string]> = []
    await runBulkSends(['a', 'b'], send, (id, outcome) => seen.push([id, outcome.state]))
    expect(order).toEqual(['send:a', 'send:b'])
    expect(seen).toEqual([
      ['a', 'sending'],
      ['a', 'sent'],
      ['b', 'sending'],
      ['b', 'failed'],
    ])
  })
})
