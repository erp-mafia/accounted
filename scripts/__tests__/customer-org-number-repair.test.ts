import { describe, expect, it } from 'vitest'
import {
  countOrgNumberRepairActions,
  isWritingAction,
  planOrgNumberRepair,
  type OrgNumberRepairRow,
} from '../lib/customer-org-number-repair'

// Synthetic personnummer only. The "ciphertext" below is a stand-in the fake
// decrypt maps back; the real cipher is exercised by the app's own tests.
const PNR = '19900101-1234'
const OTHER_PNR = '19850505-5555'
const vault: Record<string, string> = { 'ct-same': '199001011234', 'ct-other': OTHER_PNR }
const decrypt = (stored: string): string => {
  const plain = vault[stored]
  if (!plain) throw new Error('bad tag')
  return plain
}

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
