import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { INK2R_ACCOUNT_MAPPINGS } from '@/lib/reports/ink2/account-mappings'

/**
 * sru_code is what the chart of accounts shows, what new accounts are seeded
 * with and what the SIE export writes as #SRU. It must be the INK2R post the
 * INK2 engine files the account under (support report 2026-09-10: 2614 and
 * 2645 showed 7231 "Andelar i intresseföretag" instead of 7369 "Övriga
 * skulder").
 */
describe('computeSRUCode', () => {
  it.each([
    ['2614', '7369'], // utgående moms omvänd betalskyldighet: övriga skulder
    ['2645', '7369'], // beräknad ingående moms på förvärv från utlandet
    ['2611', '7369'],
    ['2731', '7369'],
    ['2510', '7368'], // skatteskulder
    ['2990', '7370'], // upplupna kostnader
    ['2440', '7365'], // leverantörsskulder
    ['2081', '7301'], // bundet eget kapital
    ['2099', '7302'], // fritt eget kapital
    ['1249', '7215'], // maskiner och inventarier, not 7202 (förskott immateriella)
    ['1510', '7251'],
    ['1930', '7281'],
    ['1310', '7230'], // group account, same post as 1311-1316
    ['1318', '7230'],
    ['1420', '7241'], // tillsatsmaterial, same post as råvaror
    ['3001', '7410'],
    ['5010', '7513'],
    ['7010', '7514'],
    ['8310', '7417'],
    ['8999', '7450'],
  ])('maps %s to INK2R %s', (account, expected) => {
    expect(computeSRUCode(account)).toBe(expected)
  })

  it('returns null for numbers no INK2R post covers', () => {
    expect(computeSRUCode('8810')).toBeNull()
    expect(computeSRUCode('8990')).toBeNull()
    expect(computeSRUCode('')).toBeNull()
    expect(computeSRUCode('19300')).toBeNull()
  })

  it('never returns a code outside the INK2R field list', () => {
    const known = new Set<string>(INK2R_ACCOUNT_MAPPINGS.map((m) => m.sruCode))
    known.add('7450')
    for (const account of BAS_REFERENCE) {
      const code = computeSRUCode(account.account_number)
      if (code !== null) expect(known.has(code), `${account.account_number} -> ${code}`).toBe(true)
    }
  })

  it('agrees with the sru_code stored in the BAS reference data for every account', () => {
    const drift = BAS_REFERENCE.filter((a) => a.sru_code !== computeSRUCode(a.account_number)).map(
      (a) => `${a.account_number}: data ${a.sru_code} vs computed ${computeSRUCode(a.account_number)}`,
    )
    expect(drift).toEqual([])
  })
})
