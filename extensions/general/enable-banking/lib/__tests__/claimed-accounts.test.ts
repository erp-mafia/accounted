import { describe, it, expect } from 'vitest'

import { describeClaimedElsewhere, partitionByClaim } from '../claimed-accounts'
import type { StoredAccount } from '../../types'

function account(over: Partial<StoredAccount> & { uid: string }): StoredAccount {
  return { currency: 'SEK', ...over }
}

describe('partitionByClaim', () => {
  it('keeps unclaimed accounts in the main list and moves claimed ones aside', () => {
    const own1 = account({ uid: 'a', iban: 'SE1' })
    const own2 = account({ uid: 'b', iban: 'SE2', enabled: false })
    const foreign = account({
      uid: 'c',
      iban: 'SE3',
      enabled: false,
      claimed_by_company_id: 'company-b',
      claimed_by_company_name: 'Testbrand Holding AB',
    })

    const { own, claimedElsewhere } = partitionByClaim([own1, foreign, own2])

    expect(own).toEqual([own1, own2])
    expect(claimedElsewhere).toEqual([foreign])
  })

  it('treats a legacy double-claim (no flag, enabled here) as own', () => {
    // The callback lets the active company's standing state outrank a sibling
    // claim, so such an account carries no flag: it must stay visible.
    const legacy = account({ uid: 'a', iban: 'SE1', enabled: true })
    expect(partitionByClaim([legacy]).own).toEqual([legacy])
    expect(partitionByClaim([legacy]).claimedElsewhere).toEqual([])
  })

  it('keeps a flagged account visible when it is enabled here (invariant breach must not hide a syncing feed)', () => {
    const flaggedButEnabled = account({ uid: 'a', iban: 'SE1', enabled: true, claimed_by_company_id: 'x' })
    const flaggedNoEnabledField = account({ uid: 'b', iban: 'SE2', claimed_by_company_id: 'x' })
    const { own, claimedElsewhere } = partitionByClaim([flaggedButEnabled, flaggedNoEnabledField])
    // enabled missing means enabled (back-compat default), so both stay own.
    expect(own).toEqual([flaggedButEnabled, flaggedNoEnabledField])
    expect(claimedElsewhere).toEqual([])
  })

  it('treats a carried deselection without a claim as own', () => {
    const deselected = account({ uid: 'a', iban: 'SE1', enabled: false, deselected_elsewhere: true })
    expect(partitionByClaim([deselected]).own).toEqual([deselected])
  })

  it('preserves order within each partition and handles an empty list', () => {
    expect(partitionByClaim([])).toEqual({ own: [], claimedElsewhere: [] })
    const rows = ['1', '2', '3', '4'].map((n, i) =>
      account({ uid: n, enabled: false, claimed_by_company_id: i % 2 ? 'x' : undefined }),
    )
    const { own, claimedElsewhere } = partitionByClaim(rows)
    expect(own.map((a) => a.uid)).toEqual(['1', '3'])
    expect(claimedElsewhere.map((a) => a.uid)).toEqual(['2', '4'])
  })
})

describe('describeClaimedElsewhere', () => {
  it('names the claimant when every account belongs to the same company', () => {
    const rows = [
      account({ uid: 'a', claimed_by_company_id: 'x', claimed_by_company_name: 'Testbrand AB' }),
      account({ uid: 'b', claimed_by_company_id: 'x', claimed_by_company_name: 'Testbrand AB' }),
    ]
    expect(describeClaimedElsewhere(rows)).toBe('2 konton synkas i Testbrand AB')
  })

  it('uses the singular noun for one account', () => {
    const rows = [account({ uid: 'a', claimed_by_company_id: 'x', claimed_by_company_name: 'Testbrand AB' })]
    expect(describeClaimedElsewhere(rows)).toBe('1 konto synkas i Testbrand AB')
  })

  it('falls back to a generic phrase when claimants differ or a name is missing', () => {
    const mixed = [
      account({ uid: 'a', claimed_by_company_id: 'x', claimed_by_company_name: 'Testbrand AB' }),
      account({ uid: 'b', claimed_by_company_id: 'y', claimed_by_company_name: 'Testbrand Holding AB' }),
    ]
    expect(describeClaimedElsewhere(mixed)).toBe('2 konton synkas i andra bolag')

    const unnamed = [account({ uid: 'a', claimed_by_company_id: 'x' })]
    expect(describeClaimedElsewhere(unnamed)).toBe('1 konto synkas i ett annat bolag')
  })

  it('does not merge two different companies that share a display name', () => {
    const sameNameDifferentIds = [
      account({ uid: 'a', claimed_by_company_id: 'x', claimed_by_company_name: 'Testbrand AB' }),
      account({ uid: 'b', claimed_by_company_id: 'y', claimed_by_company_name: 'Testbrand AB' }),
    ]
    expect(describeClaimedElsewhere(sameNameDifferentIds)).toBe('2 konton synkas i andra bolag')
  })

  it('returns an empty string for no accounts', () => {
    expect(describeClaimedElsewhere([])).toBe('')
  })
})
