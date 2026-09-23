import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  compareAmountProximity,
  normalizeCurrency,
  rankInvoicesByAmountProximity,
  type ProximityTarget,
  type RankableInvoice,
} from '../invoice-candidate-ranking'

/**
 * Ranking rule of the two manual invoice pickers (InvoicePicker,
 * SupplierInvoicePicker).
 *
 * The bug: both sorted by `Math.abs(remaining - |tx.amount|)` with no regard
 * for currency. A 1 000 EUR invoice therefore ranked as a perfect match for a
 * 1 000 SEK bank row and sorted above the genuine 1 000 SEK invoice: the same
 * number, roughly eleven times the money.
 *
 * The fix is a RANKING fix, not a filter. Every open invoice stays in the list
 * (the user must still be able to settle a foreign invoice by hand); rows only
 * move. Several tests below assert exactly that.
 *
 * The rule lives in ../invoice-candidate-ranking.ts precisely so it can be
 * tested: this repo runs Vitest in the `node` environment and never renders
 * components, so logic embedded in JSX is unverifiable by construction. The
 * final block asserts the two things a pure function cannot: that both pickers
 * actually call the helper, and that they hand it the currency fields. A guard
 * fed `undefined` and defaulted to SEK is silently inert.
 */

interface Fixture extends RankableInvoice {
  id: string
}

const invoice = (over: Partial<Fixture> & { id: string }): Fixture => ({
  remaining_amount: 1000,
  total: 1000,
  currency: 'SEK',
  exchange_rate: null,
  invoice_date: '2026-07-01',
  ...over,
})

const order = (ranked: { invoice: Fixture }[]) => ranked.map((r) => r.invoice.id)

/** Rate the reported EUR invoices were booked at. */
const EUR_RATE = 11.4967

describe('rankInvoicesByAmountProximity', () => {
  describe('same-currency ranking is unchanged', () => {
    const sekDeposit: ProximityTarget = { amount: -12500, currency: 'SEK', amountSek: null }

    it('still puts the closest SEK amount first', () => {
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'far', remaining_amount: 50000, total: 50000 }),
          invoice({ id: 'near', remaining_amount: 12600, total: 12600 }),
          invoice({ id: 'exact', remaining_amount: 12500, total: 12500 }),
        ],
        sekDeposit,
      )
      expect(order(ranked)).toEqual(['exact', 'near', 'far'])
      expect(ranked[0].proximity).toMatchObject({ basis: 'same_currency', diff: 0, exact: true })
    })

    it('still breaks an amount tie with the newest invoice first', () => {
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'older', remaining_amount: 12500, total: 12500, invoice_date: '2026-01-05' }),
          invoice({ id: 'newer', remaining_amount: 12500, total: 12500, invoice_date: '2026-06-30' }),
        ],
        sekDeposit,
      )
      expect(order(ranked)).toEqual(['newer', 'older'])
    })

    it('still ignores the sign of the bank amount', () => {
      // Supplier payments arrive negative, customer receipts positive; the
      // pickers rank both against the same outstanding amount.
      const outgoing = rankInvoicesByAmountProximity(
        [invoice({ id: 'a', remaining_amount: 12500, total: 12500 })],
        { amount: -12500, currency: 'SEK', amountSek: null },
      )
      const incoming = rankInvoicesByAmountProximity(
        [invoice({ id: 'a', remaining_amount: 12500, total: 12500 })],
        { amount: 12500, currency: 'SEK', amountSek: null },
      )
      expect(outgoing[0].proximity.exact).toBe(true)
      expect(incoming[0].proximity.exact).toBe(true)
    })
  })

  describe('the reported bug', () => {
    it('does not let a 1 000 EUR invoice out-rank a genuine 1 000 SEK match', () => {
      // The whole finding. The EUR row is listed first on input so that a
      // ranking which ignores currency (or a no-op sort) leaves it on top.
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'eur-1000', currency: 'EUR', exchange_rate: EUR_RATE }),
          invoice({ id: 'sek-1000' }),
        ],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      expect(order(ranked)).toEqual(['sek-1000', 'eur-1000'])
    })

    it('measures the EUR row against its real SEK value, not its face number', () => {
      const [, eur] = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'sek-1000' }),
          invoice({ id: 'eur-1000', currency: 'EUR', exchange_rate: EUR_RATE }),
        ],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      expect(eur.proximity).toMatchObject({
        basis: 'converted_sek',
        diff: 10496.7,
        diffCurrency: 'SEK',
        candidateSek: 11496.7,
        exact: false,
        close: false,
      })
    })
  })

  describe('foreign invoices that do have a comparable value', () => {
    it('ranks a EUR invoice first when its SEK value is what the bank moved', () => {
      // The reason cross-currency matching exists: an 11 496,70 kr deposit
      // settling a 1 000 EUR invoice. Burying it under every wildly-off SEK
      // invoice would trade one bad ranking for another.
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'sek-50000', remaining_amount: 50000, total: 50000 }),
          invoice({ id: 'sek-11000', remaining_amount: 11000, total: 11000 }),
          invoice({ id: 'eur-1000', currency: 'EUR', exchange_rate: EUR_RATE }),
        ],
        { amount: 11496.7, currency: 'SEK', amountSek: null },
      )
      expect(order(ranked)).toEqual(['eur-1000', 'sek-11000', 'sek-50000'])
      expect(ranked[0].proximity.diff).toBe(0)
    })

    it('never calls a converted figure an exact match', () => {
      // It values the invoice at its own booking rate, not at what the bank
      // actually moved. Agreeing to the öre is a coincidence, not a
      // confirmation, so the row ranks but never claims.
      const [top] = rankInvoicesByAmountProximity(
        [invoice({ id: 'eur-1000', currency: 'EUR', exchange_rate: EUR_RATE })],
        { amount: 11496.7, currency: 'SEK', amountSek: null },
      )
      expect(top.proximity.diff).toBe(0)
      expect(top.proximity.exact).toBe(false)
      expect(top.proximity.close).toBe(false)
    })

    it('prefers an exact same-currency hit over an equally close FX estimate', () => {
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'sek-11496', remaining_amount: 11496.7, total: 11496.7 }),
          invoice({ id: 'eur-1000', currency: 'EUR', exchange_rate: EUR_RATE }),
        ],
        { amount: -1000, currency: 'EUR', amountSek: -11496.7 },
      )
      expect(order(ranked)).toEqual(['eur-1000', 'sek-11496'])
      expect(ranked[0].proximity).toMatchObject({ basis: 'same_currency', exact: true })
      expect(ranked[1].proximity).toMatchObject({ basis: 'converted_sek', diff: 0 })
    })
  })

  describe('foreign invoices with no comparable value', () => {
    it('still lists an unconvertible invoice, but never on top', () => {
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'eur-no-rate', currency: 'EUR', exchange_rate: null }),
          invoice({ id: 'sek-far', remaining_amount: 90000, total: 90000 }),
        ],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      expect(order(ranked)).toEqual(['sek-far', 'eur-no-rate'])
      // Listed, not filtered: the user must still be able to pick it by hand.
      expect(ranked).toHaveLength(2)
      expect(ranked[1].proximity).toMatchObject({
        basis: 'incomparable',
        diff: null,
        diffCurrency: null,
        exact: false,
        close: false,
      })
    })

    it('treats a rate outside the shared 0 < rate < 100000 bound as no rate', () => {
      for (const exchange_rate of [0, -1, 100000, Number.NaN]) {
        const [only] = rankInvoicesByAmountProximity(
          [invoice({ id: 'eur', currency: 'EUR', exchange_rate })],
          { amount: -1000, currency: 'SEK', amountSek: null },
        )
        expect(only.proximity.basis).toBe('incomparable')
      }
    })

    it('cannot compare a foreign bank row that carries no amount_sek', () => {
      const [only] = rankInvoicesByAmountProximity(
        [invoice({ id: 'sek-1000' })],
        { amount: -1000, currency: 'NOK', amountSek: null },
      )
      expect(only.proximity.basis).toBe('incomparable')
    })

    it('orders several unconvertible rows newest first', () => {
      const ranked = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'older', currency: 'EUR', exchange_rate: null, invoice_date: '2026-02-01' }),
          invoice({ id: 'newer', currency: 'USD', exchange_rate: null, invoice_date: '2026-05-01' }),
        ],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      expect(order(ranked)).toEqual(['newer', 'older'])
    })

    it('keeps every candidate in the list whatever the currency mix', () => {
      const candidates = [
        invoice({ id: 'sek' }),
        invoice({ id: 'eur-rate', currency: 'EUR', exchange_rate: EUR_RATE }),
        invoice({ id: 'usd-no-rate', currency: 'USD', exchange_rate: null }),
        invoice({ id: 'nok-no-rate', currency: 'NOK', exchange_rate: null }),
      ]
      const ranked = rankInvoicesByAmountProximity(candidates, {
        amount: -1000,
        currency: 'SEK',
        amountSek: null,
      })
      expect(order(ranked).sort()).toEqual(candidates.map((c) => c.id).sort())
    })
  })

  describe('NULL currency is SEK', () => {
    it('treats a null invoice currency as a domestic row', () => {
      // `invoices.currency` is `text default 'SEK'` with no NOT NULL. A plain
      // `===` would read NULL as "some other currency" and demote an ordinary
      // SEK invoice into the unranked tier.
      const [only] = rankInvoicesByAmountProximity(
        [invoice({ id: 'null-currency', currency: null })],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      expect(only.proximity).toMatchObject({ basis: 'same_currency', exact: true })
    })

    it('treats a null transaction currency as a domestic row', () => {
      // `transactions.currency` is nullable too.
      const [only] = rankInvoicesByAmountProximity([invoice({ id: 'sek' })], {
        amount: -1000,
        currency: null,
        amountSek: null,
      })
      expect(only.proximity).toMatchObject({ basis: 'same_currency', exact: true })
    })

    it('ranks a null-currency row exactly like an explicit SEK row', () => {
      const explicit = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'far', remaining_amount: 9000, total: 9000, currency: 'SEK' }),
          invoice({ id: 'hit', currency: 'SEK' }),
        ],
        { amount: -1000, currency: 'SEK', amountSek: null },
      )
      const nullish = rankInvoicesByAmountProximity(
        [
          invoice({ id: 'far', remaining_amount: 9000, total: 9000, currency: null }),
          invoice({ id: 'hit', currency: null }),
        ],
        { amount: -1000, currency: null, amountSek: null },
      )
      expect(order(nullish)).toEqual(order(explicit))
    })
  })

  it('falls back to `total` when remaining_amount is missing', () => {
    const ranked = rankInvoicesByAmountProximity(
      [
        invoice({ id: 'far', remaining_amount: null, total: 40000 }),
        invoice({ id: 'hit', remaining_amount: null, total: 1000 }),
      ],
      { amount: -1000, currency: 'SEK', amountSek: null },
    )
    expect(order(ranked)).toEqual(['hit', 'far'])
  })
})

describe('compareAmountProximity', () => {
  const sek = (amount: number): ProximityTarget => ({
    amount,
    currency: 'SEK',
    amountSek: null,
  })

  it('flags a sub-öre difference as exact', () => {
    const p = compareAmountProximity(sek(-12500), { amount: 12500.004, currency: 'SEK' })
    expect(p.exact).toBe(true)
  })

  it('flags a sub-percent difference as close but not exact', () => {
    const p = compareAmountProximity(sek(-12500), { amount: 12550, currency: 'SEK' })
    expect(p).toMatchObject({ basis: 'same_currency', exact: false, close: true, diff: 50 })
  })

  it('flags a difference beyond one percent as neither', () => {
    const p = compareAmountProximity(sek(-12500), { amount: 13000, currency: 'SEK' })
    expect(p).toMatchObject({ exact: false, close: false, diff: 500 })
  })

  it('does not divide by a zero-amount bank row', () => {
    const p = compareAmountProximity(sek(0), { amount: 1000, currency: 'SEK' })
    expect(p.close).toBe(false)
    expect(Number.isFinite(p.diff!)).toBe(true)
  })

  it('rounds the converted value to whole öre', () => {
    // Money math per CLAUDE.md: Math.round(x * 100) / 100, never toFixed.
    const p = compareAmountProximity(sek(-1000), {
      amount: 33.333,
      currency: 'EUR',
      exchangeRate: 3,
    })
    expect(p.candidateSek).toBe(100)
  })

  it('reports no conversion for a SEK candidate', () => {
    // candidateSek non-null means "a conversion was performed", which is the
    // only case the row shows a SEK equivalent for.
    const p = compareAmountProximity(
      { amount: -1000, currency: 'EUR', amountSek: -11496.7 },
      { amount: 11496.7, currency: 'SEK' },
    )
    expect(p.basis).toBe('converted_sek')
    expect(p.candidateSek).toBeNull()
  })

  it('keeps the candidate SEK value even when the bank side is unconvertible', () => {
    const p = compareAmountProximity(
      { amount: -1000, currency: 'NOK', amountSek: null },
      { amount: 1000, currency: 'EUR', exchangeRate: EUR_RATE },
    )
    expect(p.basis).toBe('incomparable')
    expect(p.candidateSek).toBe(11496.7)
  })
})

describe('normalizeCurrency', () => {
  it('maps null, undefined and blank to SEK', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(normalizeCurrency(value)).toBe('SEK')
    }
  })

  it('upper-cases and trims a real code', () => {
    expect(normalizeCurrency(' eur ')).toBe('EUR')
  })
})

describe('the pickers the helper serves', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

  for (const file of ['InvoicePicker.tsx', 'SupplierInvoicePicker.tsx']) {
    describe(file, () => {
      const SRC = read(file)

      it('ranks through the shared helper', () => {
        expect(SRC).toContain('rankInvoicesByAmountProximity')
      })

      it('no longer carries the currency-blind comparator', () => {
        // The literal shape of the bug. A pure function cannot see this, and a
        // reviewer reintroducing it would otherwise get a green suite: every
        // test above would still pass while the picker sorted on its own
        // currency-blind diff.
        expect(SRC).not.toMatch(/const remain[AB]\b/)
        expect(SRC).not.toMatch(/Math\.abs\(remain[AB]\s*-/)
      })

      it('actually hands the helper the transaction currency', () => {
        // A guard reading `undefined` and defaulting to SEK is silently inert:
        // every foreign invoice would look domestic and the bug would survive
        // behind a green suite.
        expect(SRC).toMatch(/currency:\s*transaction\.currency/)
        expect(SRC).toMatch(/amountSek:\s*transaction\.amount_sek/)
      })

      it('shows the deviating currency on the row', () => {
        expect(SRC).toContain('foreignCurrency')
        expect(SRC).toContain('invoiceCurrency')
      })
    })
  }
})
