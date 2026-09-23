import { describe, it, expect } from 'vitest'
import {
  resolveFxLineSlot,
  isMonetaryLedgerAccount,
  type FxSlotLine,
} from '@/lib/bookkeeping/fx-line-slot'

/**
 * The FX metadata (currency / amount_in_currency / exchange_rate) is the only
 * record of the foreign figure behind a SEK-denominated ledger line, and every
 * consumer looks it up BY ACCOUNT: bank reconciliation resolves a foreign cash
 * account against amount_in_currency on that account's lines, voucher matching
 * narrows on `currency = invoice.currency` under the 1510/2440 prefix, storno
 * mirrors whatever is stored. So the slot has to be the leg that actually is
 * the foreign monetary item (ÅRL 4 kap. 13 §), not the first 19xx line.
 */

function line(
  account_number: string,
  debit: number,
  credit: number,
  currency?: string
): FxSlotLine {
  return { account_number, debit_amount: debit, credit_amount: credit, currency }
}

const EUR_1000 = { entryCurrency: 'EUR', exchangeRate: 11.5, foreignAmount: 1000 }

describe('resolveFxLineSlot', () => {
  describe('denomination, not account prefix', () => {
    it('stamps the EUR leg of a SEK/EUR transfer, not the SEK leg that comes first', () => {
      // 1000 EUR moved into the EUR account, paid from the SEK account. Both
      // legs carry the same SEK amount, so only the account can say which one
      // is the EUR side. The old rule took the first account starting with 19.
      const lines = [line('1930', 0, 11500), line('1932', 11500, 0)]

      const result = resolveFxLineSlot(lines, EUR_1000)

      expect(result).toEqual({ kind: 'slot', index: 1 })
      expect(lines[(result as { index: number }).index].account_number).toBe('1932')
    })

    it('is order-independent: both orders of the same transfer land on 1932', () => {
      // Both orders are asserted in ONE test on purpose. The reversed order
      // alone also passes the old "first account starting with 19" rule (1932
      // simply happens to come first there), so on its own it would pin
      // nothing; the invariant that has to hold is that the two orders agree.
      const forward = [line('1930', 0, 11500), line('1932', 11500, 0)]
      const reversed = [line('1932', 11500, 0), line('1930', 0, 11500)]

      const forwardSlot = resolveFxLineSlot(forward, EUR_1000)
      const reversedSlot = resolveFxLineSlot(reversed, EUR_1000)

      expect(forwardSlot).toEqual({ kind: 'slot', index: 1 })
      expect(reversedSlot).toEqual({ kind: 'slot', index: 0 })
      expect(forward[(forwardSlot as { index: number }).index].account_number).toBe(
        reversed[(reversedSlot as { index: number }).index].account_number
      )
    })

    it('drops the leg known to be denominated in another currency when the EUR account is non-default', () => {
      // Company books its EUR account on 1931 rather than the conventional 1932.
      const lines = [line('1930', 0, 11500), line('1931', 11500, 0)]

      const result = resolveFxLineSlot(lines, EUR_1000)

      expect(result).toEqual({ kind: 'slot', index: 1 })
    })

    it('keeps the SEK cash leg when it is the only monetary leg (EUR card purchase)', () => {
      // NO-REGRESSION guard, not a bug pin: the old rule reached 1930 here too.
      // It exists so a later narrowing of MONETARY_ACCOUNT_PREFIXES cannot
      // break the common case. A EUR purchase paid from the SEK company
      // account: the cash leg is the document leg, exactly as
      // transaction-entries.ts stamps it.
      const lines = [line('5410', 11500, 0), line('1930', 0, 11500)]

      const result = resolveFxLineSlot(lines, EUR_1000)

      expect(result).toEqual({ kind: 'slot', index: 1 })
    })

    it('picks the payable on a EUR supplier invoice with no 19xx line at all', () => {
      // The case where the old rule discarded the rate entirely.
      const lines = [line('4010', 9200, 0), line('2641', 2300, 0), line('2440', 0, 11500)]

      const result = resolveFxLineSlot(lines, EUR_1000)

      expect(result).toEqual({ kind: 'slot', index: 2 })
    })

    it('picks the payable over the non-monetary asset leg', () => {
      // A EUR machine: 1220 is measured once in SEK and never revalued, the
      // payable is the monetary item.
      const lines = [line('1220', 11500, 0), line('2440', 0, 11500)]

      expect(resolveFxLineSlot(lines, EUR_1000)).toEqual({ kind: 'slot', index: 1 })
    })

    it('tolerates the double rounding of a derived foreign amount', () => {
      // Pins the new rule's tolerance, not a behaviour change: the old rule had
      // no amount comparison at all, so it "passed" this by never checking.
      // Without the tolerance the new rule would report no_carrier here.
      // The form derives the foreign amount as roundOre(totalDebit / rate), so
      // converting it back lands 4 öre away from the booked SEK figure.
      const derived = Math.round((12500 / 11.5) * 100) / 100 // 1086.96
      expect(Math.round(derived * 11.5 * 100) / 100).not.toBe(12500)

      const lines = [line('5410', 12500, 0), line('1930', 0, 12500)]

      expect(
        resolveFxLineSlot(lines, { entryCurrency: 'EUR', exchangeRate: 11.5, foreignAmount: derived })
      ).toEqual({ kind: 'slot', index: 1 })
    })
  })

  describe('pre-pass: never two lines claiming the same foreign amount', () => {
    it('leaves an agent-created EUR draft alone instead of also stamping the bank leg', () => {
      // MCP/agent draft: the 2440 leg already carries the EUR metadata, and the
      // bank leg comes FIRST. The order-dependent latch stamped 1930 as well,
      // so two lines claimed the same 1000 EUR.
      const lines = [line('1930', 0, 11500), line('2440', 11500, 0, 'EUR')]

      const result = resolveFxLineSlot(lines, EUR_1000)

      expect(result).toEqual({ kind: 'preset', indexes: [1] })
    })

    it('resolves the same whichever side the hydrated FX line is on', () => {
      // Both orders in one test for the same reason as the transfer case above:
      // with the hydrated line FIRST the old order-dependent latch happened to
      // close before it reached the bank leg, so that order alone passed the
      // old rule too. Only the agreement between the orders is the invariant.
      const fxFirst = [line('2440', 11500, 0, 'EUR'), line('1930', 0, 11500)]
      const fxLast = [line('1930', 0, 11500), line('2440', 11500, 0, 'EUR')]

      expect(resolveFxLineSlot(fxFirst, EUR_1000)).toEqual({ kind: 'preset', indexes: [0] })
      expect(resolveFxLineSlot(fxLast, EUR_1000)).toEqual({ kind: 'preset', indexes: [1] })
    })

    it('reports a conflict when the line currency is not the entry currency', () => {
      const lines = [line('1930', 0, 11500), line('2440', 11500, 0, 'USD')]

      expect(resolveFxLineSlot(lines, EUR_1000)).toEqual({
        kind: 'unplaceable',
        reason: 'currency_conflict',
        accounts: ['2440'],
        lineCurrency: 'USD',
      })
    })
  })

  describe('refuses instead of discarding the rate', () => {
    it('reports no_carrier when no monetary leg matches the foreign amount', () => {
      // journal_entries has no currency/exchange_rate column, so a rate that is
      // not written to a line is gone: the caller must refuse, not post.
      const lines = [line('1930', 0, 11500), line('5410', 11500, 0)]

      const result = resolveFxLineSlot(lines, {
        entryCurrency: 'EUR',
        exchangeRate: 11.5,
        foreignAmount: 900, // 10 350 SEK: matches neither leg
      })

      expect(result).toMatchObject({ kind: 'unplaceable', reason: 'no_carrier' })
    })

    it('reports no_carrier when the entry has no monetary leg at all', () => {
      const lines = [line('5410', 11500, 0), line('3001', 0, 11500)]

      expect(resolveFxLineSlot(lines, EUR_1000)).toMatchObject({
        kind: 'unplaceable',
        reason: 'no_carrier',
      })
    })

    it('does not fall back onto a leg explicitly labelled SEK', () => {
      const lines = [line('1930', 0, 11500, 'SEK'), line('5410', 11500, 0)]

      expect(resolveFxLineSlot(lines, EUR_1000)).toMatchObject({
        kind: 'unplaceable',
        reason: 'no_carrier',
      })
    })

    it('reports ambiguous when two indistinguishable monetary legs match', () => {
      const lines = [line('1650', 11500, 0), line('2890', 0, 11500)]

      expect(resolveFxLineSlot(lines, EUR_1000)).toEqual({
        kind: 'unplaceable',
        reason: 'ambiguous',
        accounts: ['1650', '2890'],
      })
    })

    it('reports ambiguous when the same account carries the amount twice', () => {
      const lines = [line('1932', 11500, 0), line('1932', 11500, 0), line('1930', 0, 23000)]

      expect(resolveFxLineSlot(lines, EUR_1000)).toMatchObject({
        kind: 'unplaceable',
        reason: 'ambiguous',
      })
    })
  })

  // NO-REGRESSION guards: the old rule produced the same answers in all three
  // of these. They are here so the refusal added above cannot start firing on
  // the SEK path or on a half-filled currency panel, which would block routine
  // bookkeeping for the 95% of entries that carry no FX at all.
  describe('nothing to place', () => {
    it('returns none for a SEK entry', () => {
      const lines = [line('1930', 0, 11500), line('3001', 11500, 0)]

      expect(
        resolveFxLineSlot(lines, { entryCurrency: 'SEK', exchangeRate: 0, foreignAmount: 0 })
      ).toEqual({ kind: 'none' })
    })

    it('returns none while the rate is still missing', () => {
      const lines = [line('1930', 0, 11500), line('1932', 11500, 0)]

      expect(
        resolveFxLineSlot(lines, { entryCurrency: 'EUR', exchangeRate: 0, foreignAmount: 1000 })
      ).toEqual({ kind: 'none' })
    })

    it('preserves hydrated FX lines when the picker is back on SEK', () => {
      const lines = [line('1930', 0, 11500), line('2440', 11500, 0, 'EUR')]

      expect(
        resolveFxLineSlot(lines, { entryCurrency: 'SEK', exchangeRate: 0, foreignAmount: 0 })
      ).toEqual({ kind: 'preset', indexes: [1] })
    })
  })
})

describe('isMonetaryLedgerAccount', () => {
  it('accepts fordringar, kassa/bank and skulder', () => {
    for (const account of ['1510', '1650', '1790', '1930', '1932', '2440', '2510', '2890', '2990']) {
      expect(isMonetaryLedgerAccount(account)).toBe(true)
    }
  })

  it('rejects non-monetary items, VAT and P&L accounts', () => {
    // 1220 inventarier, 1460 lager, 1810 placeringar, 2081 aktiekapital,
    // 2150 överavskrivningar, 2220 avsättningar, 2611/2641 moms, 4010/5410/3001.
    for (const account of [
      '1220',
      '1460',
      '1810',
      '2081',
      '2150',
      '2220',
      '2611',
      '2641',
      '4010',
      '5410',
      '3001',
    ]) {
      expect(isMonetaryLedgerAccount(account)).toBe(false)
    }
  })
})
