/**
 * The daily collections run as Att göra and /pending show it: a collections
 * row in owner words ("3 förfallna fakturor föreslås för påminnelse"), never
 * an agent proposal.
 */
import { describe, expect, it } from 'vitest'
import type { BatchItem } from '../batch'
import { batchItemStep, batchRowKey, isCollectionsRun, runItems } from '../batch-dialog'

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`

function item(n: number, kind: BatchItem['kind'] = 'open', overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    kind,
    invoice_id: id(n),
    case_id: kind === 'open' ? null : id(900 + n),
    invoice_number: String(1000 + n),
    customer_name: `Kund ${n} AB`,
    due_date: '2026-09-01',
    remaining_amount: 1250,
    start_step: kind === 'approve_step' ? null : 'reminder',
    decision_kind: kind === 'approve_step' ? 'approve_collection_notice' : null,
    reminder_fee_agreed: kind === 'approve_step' ? null : false,
    bank_check: 'pass',
    ...overrides,
  }
}

describe('batchItemStep', () => {
  it('reads the first step of a handover or a reminder start', () => {
    expect(batchItemStep(item(1))).toBe('reminder')
    expect(batchItemStep(item(2, 'open', { start_step: 'collection' }))).toBe('collection')
    expect(batchItemStep(item(3, 'start'))).toBe('reminder')
  })

  it('reads the step a decision approves', () => {
    expect(batchItemStep(item(4, 'approve_step'))).toBe('collection')
    expect(batchItemStep(item(5, 'approve_step', { decision_kind: 'approve_reminder' }))).toBe('reminder')
  })
})

describe('batchRowKey', () => {
  it('names the one step every item proposes', () => {
    expect(batchRowKey([item(1), item(2, 'start')])).toBe('batch_row_reminder')
    expect(batchRowKey([item(1, 'open', { start_step: 'collection' }), item(2, 'approve_step')])).toBe('batch_row_collection')
  })

  it('says inkasso when the steps differ', () => {
    expect(batchRowKey([item(1), item(2, 'approve_step')])).toBe('batch_row_mixed')
  })

  it('falls back to the reminder wording with no items', () => {
    expect(batchRowKey([])).toBe('batch_row_reminder')
  })
})

describe('isCollectionsRun', () => {
  it('is the pending daily batch only', () => {
    expect(isCollectionsRun({ operation_type: 'collections_daily_batch', status: 'pending' })).toBe(true)
    expect(isCollectionsRun({ operation_type: 'collections_daily_batch', status: 'committed' })).toBe(false)
    expect(isCollectionsRun({ operation_type: 'open_collection_case', status: 'pending' })).toBe(false)
  })
})

describe('runItems', () => {
  it('reads the items less the ones taken out', () => {
    const params = { items: [item(1), item(2), item(3)] }
    expect(runItems(params).map((i) => i.invoice_id)).toEqual([id(1), id(2), id(3)])
    expect(runItems(params, [id(2)]).map((i) => i.invoice_id)).toEqual([id(1), id(3)])
  })

  it('answers none when the params cannot be read', () => {
    expect(runItems(null)).toEqual([])
    expect(runItems({ items: 'x' })).toEqual([])
  })
})
