import { describe, it, expect } from 'vitest'

import {
  describeClaimedElsewhere,
  describeMirrorCards,
  hasSelectableAccounts,
  partitionAccounts,
  partitionByClaim,
} from '../claimed-accounts'
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

describe('partitionAccounts', () => {
  it('leaves a card account that is off out of the listed and counted accounts (crm#1097)', () => {
    // The shape of a Svea connection after the card account was switched
    // off: the connection's details used to list it as "Synkas ej" with its
    // own balance, counted in "2 av 3 konton synkas".
    const main = account({ uid: 'a', name: 'Företagskonto', iban: 'SE1', enabled: true, balance: 1000 })
    const savings = account({ uid: 'b', name: 'Sparkonto', iban: 'SE2', enabled: true, balance: 500 })
    const card = account({ uid: 'c', name: 'SVEA_MQ_Debit_B2B', enabled: false, balance: 100 })

    const { own, claimedElsewhere, mirrorCards } = partitionAccounts([main, card, savings])

    expect(own).toEqual([main, savings])
    expect(own.filter((a) => a.enabled !== false)).toHaveLength(2)
    expect(mirrorCards).toEqual([card])
    expect(claimedElsewhere).toEqual([])
  })

  it('sets aside a card account switched on before the rule too: never a choice, on or off', () => {
    const card = account({ uid: 'c', name: 'BOKIO_Debit_Business', enabled: true })
    expect(partitionAccounts([card])).toEqual({ own: [], claimedElsewhere: [], mirrorCards: [card] })
  })

  it('keeps a card account with its own IBAN or BBAN as an account of its own', () => {
    const withIban = account({ uid: 'd', name: 'SVEA_MQ_Debit_B2B', iban: 'SE4', enabled: false })
    const withBban = account({ uid: 'e', name: 'SVEA_MQ_Debit_B2B', bban: '1234', enabled: false })
    expect(partitionAccounts([withIban, withBban]).own).toEqual([withIban, withBban])
    expect(partitionAccounts([withIban, withBban]).mirrorCards).toEqual([])
  })

  it('takes the card out before the claim split, so a claim flag cannot hide it in the disclosure', () => {
    const flaggedCard = account({ uid: 'f', name: 'SVEA_MQ_Debit_B2B', enabled: false, claimed_by_company_id: 'x' })
    const claimed = account({ uid: 'g', iban: 'SE5', enabled: false, claimed_by_company_id: 'x' })
    const { own, claimedElsewhere, mirrorCards } = partitionAccounts([flaggedCard, claimed])
    expect(own).toEqual([])
    expect(claimedElsewhere).toEqual([claimed])
    expect(mirrorCards).toEqual([flaggedCard])
  })

  it('splits by claim exactly like partitionByClaim when no card account is present', () => {
    const rows = [
      account({ uid: '1', iban: 'SE1' }),
      account({ uid: '2', iban: 'SE2', enabled: false, claimed_by_company_id: 'x' }),
      account({ uid: '3', iban: 'SE3', enabled: false }),
    ]
    const { own, claimedElsewhere, mirrorCards } = partitionAccounts(rows)
    expect({ own, claimedElsewhere }).toEqual(partitionByClaim(rows))
    expect(mirrorCards).toEqual([])
    expect(partitionAccounts([])).toEqual({ own: [], claimedElsewhere: [], mirrorCards: [] })
  })
})

describe('describeMirrorCards', () => {
  it('says why a card account that is off is not fetched', () => {
    expect(describeMirrorCards([account({ uid: 'c', name: 'SVEA_MQ_Debit_B2B', enabled: false })])).toBe(
      'Kortkontot SVEA_MQ_Debit_B2B hämtas inte: kortköpen finns redan på huvudkontot.',
    )
  })

  it('says the same of a card account an old row still has switched on: no sync fetches it', () => {
    // No promise of a save: on a failed or expired connection the save is
    // refused, and isSyncedAccount keeps every sync off the card anyway.
    expect(describeMirrorCards([account({ uid: 'c', name: 'BOKIO_Debit_Business' })])).toBe(
      'Kortkontot BOKIO_Debit_Business hämtas inte: kortköpen finns redan på huvudkontot.',
    )
  })

  it('uses the plural for several card accounts and names each', () => {
    const cards = [
      account({ uid: 'c', name: 'SVEA_MQ_Debit_B2B', enabled: false }),
      account({ uid: 'd', name: 'BOKIO_Debit_Business', enabled: false }),
    ]
    expect(describeMirrorCards(cards)).toBe(
      'Kortkontona SVEA_MQ_Debit_B2B, BOKIO_Debit_Business hämtas inte: kortköpen finns redan på huvudkontot.',
    )
  })

  it('returns an empty string for no card accounts', () => {
    expect(describeMirrorCards([])).toBe('')
  })
})

describe('hasSelectableAccounts', () => {
  const claimed = account({ uid: 'c', iban: 'SE3', enabled: false, claimed_by_company_id: 'company-b' })

  it('is false when every account is already booked by another company', () => {
    expect(hasSelectableAccounts([claimed])).toBe(false)
  })

  it('is false for a consent that carries no accounts at all', () => {
    expect(hasSelectableAccounts([])).toBe(false)
    expect(hasSelectableAccounts(null)).toBe(false)
    expect(hasSelectableAccounts(undefined)).toBe(false)
  })

  it('is true as soon as one account is this company\'s to pick, checked or not', () => {
    expect(hasSelectableAccounts([claimed, account({ uid: 'a', iban: 'SE1', enabled: false })])).toBe(true)
    expect(hasSelectableAccounts([account({ uid: 'b', enabled: false, deselected_elsewhere: true })])).toBe(true)
  })

  it('is false when the only account is a card account that mirrors the main account', () => {
    // Never a choice (lib/bank-sync/mirror-card-account.ts): a consent holding
    // nothing else has nothing to pick, so the next login replaces it.
    const card = account({ uid: 'd', name: 'SVEA_MQ_Debit_B2B', enabled: false })
    expect(hasSelectableAccounts([card])).toBe(false)
    expect(hasSelectableAccounts([card, claimed])).toBe(false)
    expect(hasSelectableAccounts([card, account({ uid: 'f', name: 'Företagskonto', iban: 'SE4', enabled: false })])).toBe(true)
  })

  it('never counts a card account as selectable, even one switched on before the rule', () => {
    // A renewal carrying only such a card would otherwise resume into a
    // picker whose save refuses the card and has nothing else to save.
    expect(hasSelectableAccounts([account({ uid: 'g', name: 'BOKIO_Debit_Business', enabled: true })])).toBe(false)
  })

  it('counts a flagged account that syncs here as selectable, the same way the picker lists it', () => {
    expect(hasSelectableAccounts([account({ uid: 'e', enabled: true, claimed_by_company_id: 'company-b' })])).toBe(true)
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
