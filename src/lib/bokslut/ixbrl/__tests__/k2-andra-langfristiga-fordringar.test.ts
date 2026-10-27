/**
 * BAS 138x is "Andra långfristiga fordringar" (1381 reversfordringar, 1385
 * kapitalförsäkring, 1389 its ackumulerade nedskrivningar). The K2 mapping
 * used to put 1380-1389 under Andra långfristiga värdepappersinnehav, so every
 * K2 årsredovisning (PDF rows come from the same mapping) and iXBRL showed
 * those balances under the wrong post. K2's own text lists "värde av
 * kapitalförsäkring" under Andra långfristiga fordringar (kapitel 11), and
 * INK2R 2.12 (SRU 7235) takes 137x and 138x together.
 */
import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '../k2-mapper'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'

function row(account: string, debit: number, credit: number): TrialBalanceRowLike {
  return { account_number: account, account_name: `Konto ${account}`, closing_debit: debit, closing_credit: credit }
}

/** The balance sheet of a year holding only `rows` (balanced against 2099). */
function brOf(rows: TrialBalanceRowLike[]) {
  const net = rows.reduce((sum, r) => sum + r.closing_debit - r.closing_credit, 0)
  const full = [...rows, net >= 0 ? row('2099', 0, net) : row('2099', -net, 0)]
  return mapTrialBalancesToK2({ full, preClosing: rows }, null).br
}

describe('K2: 1380-1389 is Andra långfristiga fordringar', () => {
  it('pins 1381 and 1389 (and 1385 kapitalförsäkring) to AndraLangfristigaFordringar', () => {
    const br = brOf([row('1381', 10_000, 0), row('1385', 5_000, 0), row('1389', 0, 2_000)])
    expect(br.AndraLangfristigaFordringar?.current).toBe(13_000)
    expect(br.AndraLangfristigaVardepappersinnehav?.current ?? 0).toBe(0)
  })

  it.each(['1380', '1381', '1382', '1383', '1384', '1385', '1387', '1388', '1389'])(
    '%s lands in Andra långfristiga fordringar, not in värdepappersinnehav',
    (account) => {
      const br = brOf([row(account, 1_000, 0)])
      expect(br.AndraLangfristigaFordringar?.current).toBe(1_000)
      expect(br.AndraLangfristigaVardepappersinnehav?.current ?? 0).toBe(0)
    },
  )

  it('keeps 135x as Andra långfristiga värdepappersinnehav', () => {
    const br = brOf([row('1350', 7_000, 0)])
    expect(br.AndraLangfristigaVardepappersinnehav?.current).toBe(7_000)
    expect(br.AndraLangfristigaFordringar?.current ?? 0).toBe(0)
  })

  it('agrees with INK2R for every BAS account in 1350-1389', () => {
    const fordringar = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === '7235')!
    const vardepapper = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === '7233')!
    const accounts = BAS_REFERENCE.map((a) => a.account_number).filter(
      (n) => (n >= '1350' && n <= '1359') || (n >= '1370' && n <= '1389'),
    )
    expect(accounts.length).toBeGreaterThan(10)
    for (const account of accounts) {
      const br = brOf([row(account, 1_000, 0)])
      if (isAccountInMapping(account, fordringar)) {
        expect(br.AndraLangfristigaFordringar?.current, account).toBe(1_000)
      } else {
        expect(isAccountInMapping(account, vardepapper), account).toBe(true)
        expect(br.AndraLangfristigaVardepappersinnehav?.current, account).toBe(1_000)
      }
    }
  })
})
