import { describe, it, expect } from 'vitest'
import { buildInvoicePaymentClearingLines } from '../invoice-payment-lines'

describe('buildInvoicePaymentClearingLines', () => {
  describe('same currency (SEK invoice + SEK tx)', () => {
    it('full payment: 1930 = 1510 = tx amount, no FX line', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1250, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1250, total: 1250, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(1250)
      expect(result.arSek).toBe(1250)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 1250, credit_amount: 0 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510', debit_amount: 0, credit_amount: 1250 })
    })

    it('partial payment: 1930 = 1510 = tx amount (the actual SEK received)', () => {
      // Scenario from the user: invoice 1 250, prior 230 partial, now 1 000 hits.
      // 1930/1510 must equal 1 000 (not 1 250). After this verifikat the invoice
      // remaining is 20 SEK and status stays partially_paid (handled by the
      // caller, not this helper).
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1020, total: 1250, paid_amount: 230 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(1000)
      expect(result.arSek).toBe(1000)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })

    it('expense tx (negative amount) treats absolute SEK value', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: -500, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 500, total: 500, paid_amount: 0 },
        'desc',
      )
      expect(result.bankSek).toBe(500)
      expect(result.arSek).toBe(500)
    })
  })

  describe('cross currency (USD invoice + SEK tx)', () => {
    it('bank received MORE SEK than booked: gain to 3960', () => {
      // Invoice 100 USD booked at 10.00 (1000 SEK on 1510)
      // Bank receives 1100 SEK (rate moved to 11.00 by payment date)
      // FX gain = 100 SEK → 3960 credit
      const result = buildInvoicePaymentClearingLines(
        { amount: 1100, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 10, remaining_amount: 100, total: 100, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(1100)
      expect(result.arSek).toBe(1000)
      expect(result.fxDiffSek).toBe(-100)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 1100 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510', credit_amount: 1000 })
      expect(result.lines[2]).toMatchObject({
        account_number: '3960',
        credit_amount: 100,
        line_description: 'Valutakursvinst',
      })
      // Balanced
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('ambiguous loss scenario (bank < SEK booked) is treated as partial — defers FX', () => {
      // Invoice 100 USD booked at 10.50 (1050 SEK on 1510)
      // Bank receives 1000 SEK — could be (a) partial payment that didn't
      // cover the full USD amount, or (b) full payment at a worse FX rate.
      // From a SEK-only bank tx we can't distinguish; defaulting to "partial"
      // is the safer choice (no premature 1510 zeroing). If the user knows
      // it's actually a full-clear-with-loss, they use mark-paid with an
      // explicit exchange_rate_difference instead.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 10.5, remaining_amount: 100, total: 100, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(1000)
      expect(result.arSek).toBe(1000)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })

    it('partial cross-currency WITH paidInInvoiceCurrency: posts proportional 1510 credit + FX-diff line', () => {
      // The proper-FX path (round-10): caller supplies the invoice-currency
      // equivalent of the bank payment, computed at today's Riksbanken rate.
      // The helper credits 1510 by that × invoice.exchange_rate (the
      // booking rate) and posts the FX-diff line so the verifikat balances.
      //
      // Scenario: 1000 SEK bank tx, invoice 140 USD @ 9.30 (booked). Today
      // Riksbanken rate: 10.45. paidInInvoiceCurrency = 1000/10.45 = 95.6938.
      // arSek = 95.6938 × 9.30 = 889.95. fxDiff = 889.95 - 1000 = -110.05
      // (negative → gain → 3960 Cr 110.05).
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 9.3, remaining_amount: 140, total: 140, paid_amount: 0 },
        'Inbetalning kundfaktura',
        95.6938, // paidInInvoiceCurrency
      )
      expect(result.bankSek).toBe(1000)
      expect(result.arSek).toBeCloseTo(889.95, 1)
      expect(result.fxDiffSek).toBeCloseTo(-110.05, 1)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 1000 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510' })
      expect(result.lines[2]).toMatchObject({
        account_number: '3960',
        line_description: 'Valutakursvinst',
      })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.005)
    })

    it('cross-currency WITH paidInInvoiceCurrency, bank < booked: loss to 7960', () => {
      // Mirror of the gain case above with the opposite sign — guards the
      // kursförlust branch the route's gain-only assertion never reaches
      // (Swedish compliance review, PR #615). Invoice 100 USD booked at 9.30
      // (930 SEK on 1510); the 100 USD settlement only fetched 900 SEK at the
      // weaker 9.00 payment-date rate. arSek = 100 × 9.30 = 930.
      // fxDiff = 930 − 900 = +30 (positive → kursförlust → 7960 Dr 30).
      const result = buildInvoicePaymentClearingLines(
        { amount: 900, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 9.3, remaining_amount: 100, total: 100, paid_amount: 0 },
        'Inbetalning kundfaktura',
        100, // paidInInvoiceCurrency (full settlement at today's 9.00 rate)
      )
      expect(result.bankSek).toBe(900)
      expect(result.arSek).toBeCloseTo(930, 2)
      expect(result.fxDiffSek).toBeCloseTo(30, 2)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 900 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510', credit_amount: 930 })
      expect(result.lines[2]).toMatchObject({
        account_number: '7960',
        debit_amount: 30,
        line_description: 'Valutakursförlust',
      })
      // Balanced to the öre: Dr 900 + 30 = 930 = Cr 930.
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.005)
    })

    it('partial cross-currency payment defers FX: bank-leg = AR-leg = bankSek, no 3960/7960 line', () => {
      // Invoice 140 USD @ 15.30 (2142 SEK booked on 1510)
      // Bank receives 230 SEK — way below the 2142 remaining. If we credited
      // the full 2142 to 1510 we'd zero the GL balance while the invoice row
      // stayed partially_paid (BFL 5 kap 4–5§ violation). Defer FX to the
      // final settlement that closes the invoice.
      const result = buildInvoicePaymentClearingLines(
        { amount: 230, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 15.3, remaining_amount: 140, total: 140, paid_amount: 0 },
        'Delbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(230)
      expect(result.arSek).toBe(230)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 230 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510', credit_amount: 230 })
    })

    it('exact match: no FX line', () => {
      // Invoice 100 USD @ 10.00 (1000 SEK booked); bank receives 1000 SEK
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 10, remaining_amount: 100, total: 100, paid_amount: 0 },
        'desc',
      )
      expect(result.bankSek).toBe(1000)
      expect(result.arSek).toBe(1000)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })

    it('sub-öre FX diff is suppressed (within floating-point tolerance)', () => {
      // 100.001 USD × 10 = 1000.01, but bookkeeping rounds at the line level
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        {
          currency: 'USD',
          exchange_rate: 10,
          remaining_amount: 100.0001,
          total: 100.0001,
          paid_amount: 0,
        },
        'desc',
      )
      expect(Math.abs(result.fxDiffSek)).toBeLessThanOrEqual(0.005)
      expect(result.lines).toHaveLength(2)
    })
  })

  describe('cross currency (USD invoice + USD tx)', () => {
    it('uses tx amount_sek for the bank-leg when populated', () => {
      // USD-denominated bank account paying a USD invoice — ingest converts
      // tx → SEK using the bank-date rate.
      const result = buildInvoicePaymentClearingLines(
        { amount: 100, amount_sek: 1100, currency: 'USD', exchange_rate: 11 },
        { currency: 'USD', exchange_rate: 10, remaining_amount: 100, total: 100, paid_amount: 0 },
        'desc',
      )
      // Same-currency path: bank-leg uses resolveSekAmount (which honours
      // amount_sek), AR-leg equals bank-leg, no FX diff line.
      expect(result.bankSek).toBe(1100)
      expect(result.arSek).toBe(1100)
      expect(result.fxDiffSek).toBe(0)
    })
  })
})
