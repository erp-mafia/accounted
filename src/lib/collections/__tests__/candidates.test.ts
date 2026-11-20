import { describe, expect, it } from 'vitest'
import { listCollectionCandidates } from '../candidates'
import { CONNECTION_ID, INVOICE_ID, OPENED_AT, createCaseWorld } from './case-fixtures'
import { COMPANY_ID } from './memory-supabase'

const connection = { minimum_amount: 0, reminder_fee_terms_since: null }

function closedCase(overrides: Record<string, unknown>) {
  return {
    id: 'case-closed',
    company_id: COMPANY_ID,
    invoice_id: INVOICE_ID,
    connection_id: CONNECTION_ID,
    submission_status: 'registered',
    stage: 'closed_paid',
    is_open: false,
    close_reason: 'paid',
    created_at: '2026-09-01T08:00:00.000Z',
    ...overrides,
  }
}

describe('listCollectionCandidates', () => {
  it('lists an overdue unpaid invoice with no case as a candidate', async () => {
    const world = await createCaseWorld()
    const candidates = await listCollectionCandidates(world.db.client, {
      companyId: COMPANY_ID,
      connection,
      features: null,
      now: new Date(OPENED_AT),
    })
    expect(candidates.map((c) => c.invoice_id)).toEqual([INVOICE_ID])
  })

  it('leaves out an invoice whose latest case the provider closed as paid until the payment is booked', async () => {
    const world = await createCaseWorld()
    world.db.seed('collection_cases', [closedCase({})])
    const input = { companyId: COMPANY_ID, connection, features: null, now: new Date(OPENED_AT) }
    expect(await listCollectionCandidates(world.db.client, input)).toEqual([])
    const all = await listCollectionCandidates(world.db.client, { ...input, includeIneligible: true })
    expect(all).toHaveLength(1)
    expect(all[0].blocks).toContain('elig_collected_unbooked')
  })

  it('reads only the latest registered case: a later withdrawn case lifts the block', async () => {
    const world = await createCaseWorld()
    world.db.seed('collection_cases', [
      closedCase({}),
      closedCase({ id: 'case-later', stage: 'closed_other', close_reason: 'withdrawn', created_at: '2026-09-20T08:00:00.000Z' }),
      // A refused handover is never the provider's answer about payment.
      closedCase({ id: 'case-refused', submission_status: 'failed', stage: 'closed_paid', created_at: '2026-09-25T08:00:00.000Z' }),
    ])
    const candidates = await listCollectionCandidates(world.db.client, {
      companyId: COMPANY_ID,
      connection,
      features: null,
      now: new Date(OPENED_AT),
      includeIneligible: true,
    })
    expect(candidates[0].blocks).not.toContain('elig_collected_unbooked')
  })
})
