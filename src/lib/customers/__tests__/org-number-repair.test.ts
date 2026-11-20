import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// Synthetic personnummer only. The "ciphertext" below is a stand-in the fake
// decrypt maps back; the real cipher is exercised by the app's own tests.
const { PNR, decrypt } = vi.hoisted(() => {
  const vault: Record<string, string> = { 'ct-same': '199001011234', 'ct-other': '19850505-5555' }
  const decrypt = (stored: string): string => {
    const plain = vault[stored]
    if (!plain) throw new Error('bad tag')
    return plain
  }
  return { PNR: '19900101-1234', decrypt }
})

vi.mock('@/lib/customers/protect-personal-number', () => ({
  encryptCustomerPersonalNumber: (value: string | null) => (value ? `sealed(${value})` : null),
  revealStoredCustomerPersonalNumber: (value: string | null) => (value ? decrypt(value) : null),
}))

import {
  countOrgNumberRepairActions,
  isWritingAction,
  planOrgNumberRepair,
  repairIndividualOrgNumbers,
  type OrgNumberRepairRow,
} from '../org-number-repair'

function row(overrides: Partial<OrgNumberRepairRow> = {}): OrgNumberRepairRow {
  return { customer_type: 'individual', org_number: PNR, personal_number: null, ...overrides }
}

describe('planOrgNumberRepair', () => {
  it('moves the personnummer when personal_number is empty', () => {
    expect(planOrgNumberRepair(row(), decrypt)).toBe('move')
  })

  it('only clears org_number when personal_number holds the same number in another written form', () => {
    expect(planOrgNumberRepair(row({ personal_number: 'ct-same' }), decrypt)).toBe('clear_same')
  })

  it('clears org_number but reports it when personal_number holds a different number', () => {
    expect(planOrgNumberRepair(row({ personal_number: 'ct-other' }), decrypt)).toBe('clear_differ')
  })

  it('leaves a row alone when the stored personal_number cannot be decrypted', () => {
    expect(planOrgNumberRepair(row({ personal_number: 'garbage' }), decrypt)).toBe('skip_unreadable')
  })

  it('leaves an org number that is not a personnummer for a manual decision', () => {
    expect(planOrgNumberRepair(row({ org_number: '556677-8899' }), decrypt)).toBe('skip_not_personal_number')
  })

  it('ignores business rows and individuals without an org number', () => {
    expect(planOrgNumberRepair(row({ customer_type: 'swedish_business' }), decrypt)).toBeNull()
    expect(planOrgNumberRepair(row({ org_number: null }), decrypt)).toBeNull()
    expect(planOrgNumberRepair(row({ org_number: '' }), decrypt)).toBeNull()
    expect(planOrgNumberRepair(row({ org_number: '   ' }), decrypt)).toBeNull()
  })
})

describe('countOrgNumberRepairActions / isWritingAction', () => {
  it('counts every action, zero when unused', () => {
    expect(countOrgNumberRepairActions(['move', 'move', 'clear_differ'])).toEqual({
      move: 2,
      clear_same: 0,
      clear_differ: 1,
      skip_unreadable: 0,
      skip_not_personal_number: 0,
    })
  })

  it('writes only for the move and clear actions', () => {
    expect(isWritingAction('move')).toBe(true)
    expect(isWritingAction('clear_same')).toBe(true)
    expect(isWritingAction('clear_differ')).toBe(true)
    expect(isWritingAction('skip_unreadable')).toBe(false)
    expect(isWritingAction('skip_not_personal_number')).toBe(false)
  })
})

describe('repairIndividualOrgNumbers', () => {
  const { supabase, enqueue, enqueueMany, reset, findCalls } = createQueuedMockSupabase()
  const card = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, company_id: 'co-1', user_id: 'u-1', customer_type: 'individual', org_number: PNR, personal_number: null, ...overrides,
  })
  const options = { apply: true, actorLabel: 'test repair' }

  beforeEach(() => reset())

  it('reads, decides and counts in a dry run, and writes nothing', async () => {
    enqueue({ data: [card('c1'), card('c2', { personal_number: 'ct-same' }), card('c3', { company_id: 'co-2', org_number: '556677-8899' })] })
    const run = await repairIndividualOrgNumbers(supabase as never, { ...options, apply: false })
    expect(run).toMatchObject({ individuals: 3, companies: 2, written: 0, stopped: null })
    expect(run.counts).toMatchObject({ move: 1, clear_same: 1, skip_not_personal_number: 1 })
    expect(findCalls('customers', 'update')).toHaveLength(0)
    expect(findCalls('audit_log', 'insert')).toHaveLength(0)
  })

  it('moves the personnummer into personal_number, guarded on what it read, and audits without the value', async () => {
    enqueueMany([
      { data: [card('c1'), card('c2', { personal_number: 'ct-same' })] },
      { data: [{ id: 'c1' }] }, {},
      { data: [{ id: 'c2' }] }, {},
    ])
    const run = await repairIndividualOrgNumbers(supabase as never, options)
    expect(run).toMatchObject({ written: 2, changedUnderneath: 0, failed: {}, stopped: null })
    expect(findCalls('customers', 'update')).toEqual([
      [{ org_number: null, personal_number: `sealed(${PNR})` }],
      [{ org_number: null }],
    ])
    expect(findCalls('customers', 'eq')).toContainEqual(['org_number', PNR])
    expect(findCalls('customers', 'is')).toContainEqual(['personal_number', null])
    expect(findCalls('customers', 'eq')).toContainEqual(['personal_number', 'ct-same'])
    const audits = findCalls('audit_log', 'insert').map(([payload]) => payload)
    expect(audits[0]).toMatchObject({ record_id: 'c1', actor_type: 'system', actor_label: 'test repair', new_state: { repair_action: 'move' } })
    expect(audits[1]).toMatchObject({ record_id: 'c2', new_state: { repair_action: 'clear_same' } })
    expect(JSON.stringify(audits)).not.toContain('1234')
  })

  it('skips a row that changed underneath, counts a failed write by its code and carries on', async () => {
    enqueueMany([
      { data: [card('c1'), card('c2'), card('c3')] },
      { data: [] },
      { error: { code: '23514', message: 'check violation' } },
      { data: [{ id: 'c3' }] }, {},
    ])
    const run = await repairIndividualOrgNumbers(supabase as never, options)
    expect(run).toMatchObject({ written: 1, changedUnderneath: 1, failed: { 23514: 1 }, stopped: null })
    expect(findCalls('audit_log', 'insert')).toHaveLength(1)
  })

  it('stops at a failed audit row, so at most one written row lacks its trace', async () => {
    enqueueMany([
      { data: [card('c1'), card('c2')] },
      { data: [{ id: 'c1' }] },
      { error: { code: '42501', message: 'permission denied' } },
    ])
    const run = await repairIndividualOrgNumbers(supabase as never, options)
    expect(run).toMatchObject({ written: 1, stopped: 'audit_failed', auditError: '42501' })
    expect(findCalls('customers', 'update')).toHaveLength(1)
  })

  it('writes nothing past the deadline and says so', async () => {
    enqueue({ data: [card('c1')] })
    const run = await repairIndividualOrgNumbers(supabase as never, { ...options, deadline: Date.now() - 1 })
    expect(run).toMatchObject({ individuals: 1, written: 0, stopped: 'deadline' })
    expect(findCalls('customers', 'update')).toHaveLength(0)
  })
})
