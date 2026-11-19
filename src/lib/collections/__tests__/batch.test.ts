import { describe, expect, it } from 'vitest'
import { batchConfirmationMatches, batchParamsSchema, batchSkipReason, collectionWorkCounts, remainingBatchItems, type BatchItem } from '../batch'

const A = '11111111-1111-4111-8111-1111111111aa'
const B = '11111111-1111-4111-8111-1111111111bb'

function item(invoiceId: string, kind: BatchItem['kind'] = 'open'): BatchItem {
  return {
    kind,
    invoice_id: invoiceId,
    case_id: kind === 'open' ? null : '11111111-1111-4111-8111-1111111111cc',
    invoice_number: 'F-1',
    customer_name: 'Kund AB',
    due_date: '2026-09-01',
    remaining_amount: 1250,
    start_step: kind === 'approve_step' ? null : 'reminder',
    decision_kind: kind === 'approve_step' ? 'approve_reminder' : null,
    reminder_fee_agreed: kind === 'approve_step' ? null : false,
    bank_check: 'pass',
  }
}

describe('batchSkipReason', () => {
  it.each([
    ['COLLECTION_REMAINING_CHANGED', undefined, false, 'changed'],
    ['COLLECTION_BANK_CANDIDATES', undefined, false, 'bank'],
    ['COLLECTION_BANK_STALE', undefined, false, 'bank'],
    ['COLLECTION_PAYMENT_NOT_REPORTED', undefined, false, 'bank'],
    ['COLLECTION_ATTESTATION_REQUIRED', { attestations: ['bank'] }, false, 'bank'],
    ['COLLECTION_ATTESTATION_REQUIRED', { attestations: ['delivery'] }, false, 'ineligible'],
    ['COLLECTION_NOT_ELIGIBLE', undefined, false, 'ineligible'],
    ['COLLECTION_CUSTOMER_EXCLUDED', undefined, false, 'ineligible'],
    ['CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE', undefined, true, 'ineligible'],
    ['CONNECTOR_UNREACHABLE', undefined, true, 'connector'],
    ['COLLECTIONS_UNAVAILABLE', undefined, false, 'connector'],
    ['INTERNAL_ERROR', undefined, false, 'error'],
  ] as const)('%s -> %s', (code, details, upstream, reason) => {
    expect(batchSkipReason(code, details as Record<string, unknown> | undefined, upstream)).toBe(reason)
  })
})

describe('remainingBatchItems', () => {
  it('leaves out exactly the removed items and adds nothing', () => {
    const params = { items: [item(A), item(B), item(A, 'approve_step')] }
    expect(remainingBatchItems(params, [{ invoice_id: A, kind: 'open' }])).toEqual([item(B), item(A, 'approve_step')])
    expect(remainingBatchItems(params, [{ invoice_id: '11111111-1111-4111-8111-1111111111dd', kind: 'open' }])).toEqual(params.items)
    expect(remainingBatchItems(params, [])).toEqual(params.items)
  })
})

describe('batchParamsSchema', () => {
  it('reads a staged batch and refuses an item whose bank check did not pass', () => {
    const params = { batch_date: '2026-10-07', connection_id: '11111111-1111-4111-8111-1111111111ee', items: [item(A)], excluded: [] }
    expect(batchParamsSchema.safeParse(params).success).toBe(true)
    expect(batchParamsSchema.safeParse({ ...params, items: [{ ...item(A), bank_check: 'stale' }] }).success).toBe(false)
  })
})

describe('batchConfirmationMatches', () => {
  it('wants the typed word, case and spaces aside', () => {
    expect(batchConfirmationMatches('skicka')).toBe(true)
    expect(batchConfirmationMatches('  Skicka ')).toBe(true)
    expect(batchConfirmationMatches('godkänn')).toBe(false)
    expect(batchConfirmationMatches('')).toBe(false)
  })
})

describe('collectionWorkCounts (Att göra counts an invoice once)', () => {
  const CASE = '11111111-1111-4111-8111-1111111111cc'

  it('leaves a decision the batch proposes to the batch row', () => {
    expect(collectionWorkCounts([CASE, 'other-case'], [item(A), item(B, 'approve_step')], [])).toEqual({ decision: 1, batchReady: 2 })
  })

  it('gives a decision back to the decision row once it is taken out of the batch', () => {
    expect(collectionWorkCounts([CASE], [item(A), item(B, 'approve_step')], [{ invoice_id: B, kind: 'approve_step' }])).toEqual({
      decision: 1,
      batchReady: 1,
    })
  })

  it('counts every decision without a batch', () => {
    expect(collectionWorkCounts([CASE], [], [])).toEqual({ decision: 1, batchReady: 0 })
  })
})
