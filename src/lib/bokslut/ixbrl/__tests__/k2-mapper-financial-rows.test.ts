import { describe, expect, it } from 'vitest'
import {
  K2_RR_MAPPINGS,
  mapTrialBalancesToK2,
  type TrialBalancePair,
  type TrialBalanceRowLike,
} from '../k2-mapper'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import { CLASS_8_ACCOUNTS } from '@/lib/bookkeeping/bas-data/class-8-financial'

// INK2R 3.12-3.18 and the K2 RR finansiella poster are the same ÅRL rows
// (crm#1726): an account must land on the same row in both.
const SRU_TO_CONCEPT: Record<string, string> = {
  '7414': 'ResultatAndelarKoncernforetag',
  '7415': 'ResultatAndelarIntresseforetagGemensamtStyrda',
  '7423': 'ResultatOvrigaforetagAgarintresse',
  '7416': 'ResultatOvrigaFinansiellaAnlaggningstillgangar',
  '7417': 'OvrigaRanteintakterLiknandeResultatposter',
  '7521': 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar',
  '7522': 'RantekostnaderLiknandeResultatposter',
}

function k2ConceptsFor(account: string): string[] {
  return K2_RR_MAPPINGS.filter((m) =>
    m.ranges.some((range) => account >= range.start && account <= range.end),
  ).map((m) => m.concept)
}

function ink2rSruFor(account: string): string[] {
  return INK2R_ACCOUNT_MAPPINGS.filter(
    (m) => m.section === 'income_statement' && isAccountInMapping(account, m),
  ).map((m) => m.sruCode)
}

const row = (account: string, debit: number, credit: number): TrialBalanceRowLike => ({
  account_number: account,
  account_name: `Konto ${account}`,
  closing_debit: debit,
  closing_credit: credit,
})

/** A closed year: the RR account is open pre-closing, 2099 carries the result. */
function closedYear(account: string, debit: number, credit: number): TrialBalancePair {
  const result = credit - debit
  const equity =
    result >= 0 ? row('2099', 0, result) : row('2099', -result, 0)
  const bank = result >= 0 ? row('1930', result, 0) : row('1930', 0, -result)
  return {
    full: [bank, equity],
    preClosing: [bank, row(account, debit, credit)],
  }
}

describe('K2 RR finansiella poster mapping', () => {
  it('maps every account 8000-8499 to the row of its INK2R field', () => {
    const mismatches: string[] = []
    for (let n = 8000; n <= 8499; n++) {
      const account = String(n)
      const sru = ink2rSruFor(account)
      const concepts = k2ConceptsFor(account)
      const expected = sru.length === 1 ? SRU_TO_CONCEPT[sru[0]] : undefined
      if (concepts.length !== 1 || concepts[0] !== expected) {
        mismatches.push(`${account}: k2=${concepts.join('|') || '-'} ink2r=${sru.join('|') || '-'}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('maps every BAS class 8 account up to 8499 to the row of its BAS SRU code', () => {
    const accounts = CLASS_8_ACCOUNTS.filter((a) => a.account_number <= '8499')
    expect(accounts.length).toBeGreaterThan(100)
    for (const account of accounts) {
      expect(
        { account: account.account_number, concepts: k2ConceptsFor(account.account_number) },
      ).toEqual({
        account: account.account_number,
        concepts: [SRU_TO_CONCEPT[account.sru_code ?? '']],
      })
    }
  })

  it.each([
    ['8069', 'ResultatAndelarKoncernforetag'],
    ['8070', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8089', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8090', 'ResultatAndelarKoncernforetag'],
    ['8112', 'ResultatAndelarIntresseforetagGemensamtStyrda'],
    ['8113', 'ResultatOvrigaforetagAgarintresse'],
    ['8114', 'ResultatAndelarIntresseforetagGemensamtStyrda'],
    ['8118', 'ResultatOvrigaforetagAgarintresse'],
    ['8123', 'ResultatOvrigaforetagAgarintresse'],
    ['8133', 'ResultatOvrigaforetagAgarintresse'],
    ['8169', 'ResultatAndelarIntresseforetagGemensamtStyrda'],
    ['8170', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8189', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8190', 'ResultatAndelarIntresseforetagGemensamtStyrda'],
    ['8200', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    ['8210', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    ['8269', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    ['8270', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8289', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8290', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    ['8299', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    ['8300', 'OvrigaRanteintakterLiknandeResultatposter'],
    ['8369', 'OvrigaRanteintakterLiknandeResultatposter'],
    ['8370', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8389', 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ['8390', 'OvrigaRanteintakterLiknandeResultatposter'],
    ['8400', 'RantekostnaderLiknandeResultatposter'],
    ['8499', 'RantekostnaderLiknandeResultatposter'],
  ])('boundary account %s maps to %s', (account, concept) => {
    expect(k2ConceptsFor(account)).toEqual([concept])
  })

  it('reports a dividend on 8210 under övriga finansiella anläggningstillgångar, not ägarintresse', () => {
    const result = mapTrialBalancesToK2(
      closedYear('8210', 0, 50_000),
      closedYear('8210', 0, 20_000),
    )
    expect(result.rr['ResultatOvrigaFinansiellaAnlaggningstillgangar']).toEqual({
      current: 50_000,
      previous: 20_000,
    })
    expect(result.rr['ResultatOvrigaforetagAgarintresse']).toEqual({ current: 0, previous: 0 })
    expect(result.totals.finansiellaPoster.current).toBe(50_000)
    expect(result.totals.aretsResultat.current).toBe(50_000)
    expect(result.unmappedAccounts).toEqual([])
  })

  it('reports a write-down of other shares (8271) as a nedskrivning, keeping the result', () => {
    const result = mapTrialBalancesToK2(closedYear('8271', 30_000, 0), null)
    expect(
      result.rr['NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    ).toEqual({ current: 30_000, previous: null })
    expect(result.rr['ResultatOvrigaFinansiellaAnlaggningstillgangar']?.current ?? 0).toBe(0)
    expect(result.totals.finansiellaPoster.current).toBe(-30_000)
    expect(result.totals.aretsResultat.current).toBe(-30_000)
  })

  it('reports a dividend on 8113 under ägarintresse', () => {
    const result = mapTrialBalancesToK2(closedYear('8113', 0, 12_000), null)
    expect(result.rr['ResultatOvrigaforetagAgarintresse']).toEqual({
      current: 12_000,
      previous: null,
    })
    expect(result.rr['ResultatAndelarIntresseforetagGemensamtStyrda']?.current ?? 0).toBe(0)
  })
})
