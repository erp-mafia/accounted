import { describe, it, expect } from 'vitest'
import {
  buildInvoicePaymentClearingLines,
  InvoiceBookingRateMissingError,
  MATCH_INVOICE_BOOKING_RATE_MISSING,
} from '../invoice-payment-lines'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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

    it('ambiguous loss scenario (bank < SEK booked) is treated as partial: defers FX', () => {
      // Invoice 100 USD booked at 10.50 (1050 SEK on 1510)
      // Bank receives 1000 SEK: could be (a) partial payment that didn't
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
      // Mirror of the gain case above with the opposite sign: guards the
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
      // Bank receives 230 SEK: way below the 2142 remaining. If we credited
      // the full 2142 to 1510 we'd zero the GL balance while the invoice row
      // stayed partially_paid (BFL 5 kap 4-5§ violation). Defer FX to the
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

  describe('öresavrundning (pure SEK, sub-krona difference → 3740)', () => {
    it('customer paid a sub-krona SHORT: clears full 1510, books 3740 debit (förlust)', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1000.25, total: 1000.25, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.arSek).toBe(1000.25) // full remaining cleared → invoice settles
      expect(result.oreRoundingSek).toBe(0.25)
      expect(result.lines).toHaveLength(3)
      expect(result.lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(1000)
      expect(result.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(1000.25)
      expect(result.lines.find((l) => l.account_number === '3740')?.debit_amount).toBe(0.25)
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('customer paid a sub-krona OVER: clears full 1510, books 3740 credit (vinst)', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000.25, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.arSek).toBe(1000)
      expect(result.oreRoundingSek).toBe(-0.25)
      expect(result.lines.find((l) => l.account_number === '3740')?.credit_amount).toBe(0.25)
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('a ≥1 kr shortfall stays a partial (no 3740, AR = bank)', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 600, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Delbetalning kundfaktura',
      )
      expect(result.arSek).toBe(600)
      expect(result.oreRoundingSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })
  })

  describe('same currency foreign (USD invoice + USD tx)', () => {
    it('clears 1510 at the booking rate and books the realized kursdiff, using tx amount_sek for the bank-leg', () => {
      // USD-denominated bank account paying a USD invoice: ingest converts
      // tx → SEK using the bank-date rate (amount_sek = 1 100). The 100 USD
      // receivable was BOOKED at 10,00 (1 000 kr on 1510), so:
      //   arSek     = 100 × 10,00 = 1 000,00
      //   fxDiffSek = 1 000,00 − 1 100,00 = −100,00 → kursvinst → 3960 Cr 100
      const result = buildInvoicePaymentClearingLines(
        { amount: 100, amount_sek: 1100, currency: 'USD', exchange_rate: 11 },
        { currency: 'USD', exchange_rate: 10, remaining_amount: 100, total: 100, paid_amount: 0 },
        'desc',
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
      // Balanced: Dr 1100 = Cr 1000 + 100.
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })
  })

  describe('missing invoice booking rate (foreign invoice, no exchange_rate)', () => {
    // Reported case: a 1 000 EUR invoice settled by an 11 496,70 kr deposit
    // while invoice.exchange_rate was never populated. The old `?? 1` valued
    // the receivable at 1 000 (EUR read as SEK) and posted
    // 11 496,70 − 1 000 = 10 496,70 kr to 3960 as a phantom kursvinst:
    // revenue understated and FX gain overstated by the whole amount, with a
    // verifikat that balanced so no trigger fired. Per ML 8 kap 21-23§ the
    // receivable is valued at the rate on the taxable event and the FX
    // difference is the movement between that rate and the settlement rate:
    // with no booking rate there is no difference to compute, only a guess.
    const EUR_INVOICE_NO_RATE = {
      currency: 'EUR',
      exchange_rate: null,
      remaining_amount: 1000,
      total: 1000,
      paid_amount: 0,
    }
    const BANK_11496_70 = {
      amount: 11496.7,
      amount_sek: null,
      currency: 'SEK',
      exchange_rate: null,
    }

    it('fallback path (no paidInInvoiceCurrency): throws instead of booking a 10 496,70 phantom 3960 gain', () => {
      expect(() =>
        buildInvoicePaymentClearingLines(
          BANK_11496_70,
          EUR_INVOICE_NO_RATE,
          'Inbetalning kundfaktura',
        ),
      ).toThrow(InvoiceBookingRateMissingError)
    })

    it('spot-rate path (with paidInInvoiceCurrency): throws too', () => {
      // paidInInvoiceCurrency = 11496.70 / 11.4967 = 1000 EUR. Without the
      // BOOKING rate the AR leg is still unknown, so this path must fail
      // exactly like the fallback: it used the same `?? 1`.
      expect(() =>
        buildInvoicePaymentClearingLines(
          BANK_11496_70,
          EUR_INVOICE_NO_RATE,
          'Inbetalning kundfaktura',
          1000,
        ),
      ).toThrow(InvoiceBookingRateMissingError)
    })

    it('carries the structured code and the offending currency/rate', () => {
      try {
        buildInvoicePaymentClearingLines(BANK_11496_70, EUR_INVOICE_NO_RATE, 'desc')
        expect.unreachable('should have thrown')
      } catch (err) {
        const e = err as InvoiceBookingRateMissingError
        expect(e.code).toBe(MATCH_INVOICE_BOOKING_RATE_MISSING)
        expect(e.invoiceCurrency).toBe('EUR')
        expect(e.exchangeRate).toBeNull()
      }
    })

    it('resolves to the actionable Swedish message (registry wiring)', () => {
      const err = new InvoiceBookingRateMissingError('EUR', null)
      const message = getErrorMessage(err)
      expect(message).toContain('växelkurs')
      // Never the raw English engine text.
      expect(message).not.toContain('exchange rate')
    })

    it('a zero or absurd rate is as unusable as null', () => {
      for (const rate of [0, -9.3, 1e6]) {
        expect(() =>
          buildInvoicePaymentClearingLines(
            BANK_11496_70,
            { ...EUR_INVOICE_NO_RATE, exchange_rate: rate },
            'desc',
          ),
        ).toThrow(InvoiceBookingRateMissingError)
      }
    })

    it('WITH a booking rate the same settlement books a real kursvinst on 3960', () => {
      // 1 000 EUR booked at 11,30 (11 300 kr on 1510); the bank credited
      // 11 496,70 kr. Real gain = 196,70 kr, not 10 496,70.
      const result = buildInvoicePaymentClearingLines(
        BANK_11496_70,
        { ...EUR_INVOICE_NO_RATE, exchange_rate: 11.3 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(11496.7)
      expect(result.arSek).toBe(11300)
      expect(result.fxDiffSek).toBe(-196.7)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[2]).toMatchObject({
        account_number: '3960',
        debit_amount: 0,
        credit_amount: 196.7,
        line_description: 'Valutakursvinst',
      })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('WITH a booking rate above the settlement rate it books a kursförlust on 7960', () => {
      // Same 1 000 EUR settled for 11 496,70 kr, but booked at 11,60
      // (11 600 kr on 1510): the 1 000 EUR fetched 103,30 kr less than booked.
      const result = buildInvoicePaymentClearingLines(
        BANK_11496_70,
        { ...EUR_INVOICE_NO_RATE, exchange_rate: 11.6 },
        'Inbetalning kundfaktura',
        1000,
      )
      expect(result.bankSek).toBe(11496.7)
      expect(result.arSek).toBe(11600)
      expect(result.fxDiffSek).toBe(103.3)
      expect(result.lines[2]).toMatchObject({
        account_number: '7960',
        debit_amount: 103.3,
        credit_amount: 0,
        line_description: 'Valutakursförlust',
      })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('a SEK invoice with no exchange_rate is completely unaffected', () => {
      // "Currency is SEK" and "rate is missing" are different conditions: a
      // SEK receivable already carries its SEK value, so no rate is consulted
      // and nothing may throw. exchange_rate is null on every SEK invoice.
      const result = buildInvoicePaymentClearingLines(
        { amount: 11496.7, amount_sek: null, currency: 'SEK', exchange_rate: null },
        {
          currency: 'SEK',
          exchange_rate: null,
          remaining_amount: 11496.7,
          total: 11496.7,
          paid_amount: 0,
        },
        'Inbetalning kundfaktura',
      )
      expect(result.arSek).toBe(11496.7)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })

    it('a SEK invoice paid from a foreign-currency bank account still needs no invoice rate', () => {
      // !invoiceIsForeign branch: the tx side carries its own rate/amount_sek.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: 11496.7, currency: 'EUR', exchange_rate: 11.4967 },
        {
          currency: 'SEK',
          exchange_rate: null,
          remaining_amount: 11496.7,
          total: 11496.7,
          paid_amount: 0,
        },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(11496.7)
      expect(result.arSek).toBe(11496.7)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })

    it('a same-currency foreign settlement (EUR invoice, EUR tx) also requires the booking rate', () => {
      // Without the booking rate the SEK value the receivable was posted at
      // is unknown, so neither the 1510 credit nor the kursdiff is computable.
      // The old shape (arSek = bankSek, fxDiffSek = 0) credited 1510 at the
      // settlement-date value and stranded the realized kursdiff there.
      expect(() =>
        buildInvoicePaymentClearingLines(
          { amount: 1000, amount_sek: 11496.7, currency: 'EUR', exchange_rate: 11.4967 },
          { ...EUR_INVOICE_NO_RATE },
          'Inbetalning kundfaktura',
        ),
      ).toThrow(InvoiceBookingRateMissingError)
    })
  })

  describe('same-currency foreign settlement (EUR invoice, EUR tx) with a booking rate', () => {
    it('clears 1510 at the booking rate and books the realized kursvinst on 3960', () => {
      // 1 000 EUR booked at 11,30 → 1510 was debited 11 300,00 at issuance.
      // The EUR receipt is worth 11 496,70 kr on the bank date.
      //   arSek     = 1 000 × 11,30 = 11 300,00
      //   fxDiffSek = 11 300,00 − 11 496,70 = −196,70 → kursvinst → 3960 Cr
      // Balanced: Dr 11 496,70 = Cr 11 300,00 + 196,70.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: 11496.7, currency: 'EUR', exchange_rate: 11.4967 },
        { currency: 'EUR', exchange_rate: 11.3, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(11496.7)
      expect(result.arSek).toBe(11300)
      expect(result.fxDiffSek).toBe(-196.7)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 11496.7 })
      expect(result.lines[1]).toMatchObject({ account_number: '1510', credit_amount: 11300 })
      expect(result.lines[2]).toMatchObject({
        account_number: '3960',
        debit_amount: 0,
        credit_amount: 196.7,
        line_description: 'Valutakursvinst',
      })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('books the realized kursförlust on 7960 when the booking rate was higher', () => {
      // Same 1 000 EUR settlement worth 11 496,70 kr, but booked at 11,60:
      //   arSek     = 1 000 × 11,60 = 11 600,00
      //   fxDiffSek = 11 600,00 − 11 496,70 = +103,30 → kursförlust → 7960 Dr
      // Balanced: Dr 11 496,70 + 103,30 = 11 600,00 = Cr 11 600,00.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: 11496.7, currency: 'EUR', exchange_rate: 11.4967 },
        { currency: 'EUR', exchange_rate: 11.6, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(11496.7)
      expect(result.arSek).toBe(11600)
      expect(result.fxDiffSek).toBe(103.3)
      expect(result.lines[2]).toMatchObject({
        account_number: '7960',
        debit_amount: 103.3,
        credit_amount: 0,
        line_description: 'Valutakursförlust',
      })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('a partial same-currency payment credits 1510 proportionally with an accurate FX line', () => {
      // 400 of 1 000 EUR paid; booked at 11,30. Bank-date value 4 598,68 kr
      // (400 × 11,4967). arSek = 400 × 11,30 = 4 520,00.
      // fxDiffSek = 4 520,00 − 4 598,68 = −78,68 → 3960 Cr 78,68.
      // Balanced: Dr 4 598,68 = Cr 4 520,00 + 78,68. Same partial-payment
      // contract as the preferred cross-currency path: 1510 moves in step
      // with the AR sub-ledger and the realized kursdiff is booked now.
      const result = buildInvoicePaymentClearingLines(
        { amount: 400, amount_sek: 4598.68, currency: 'EUR', exchange_rate: 11.4967 },
        { currency: 'EUR', exchange_rate: 11.3, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Delbetalning kundfaktura',
      )
      expect(result.bankSek).toBe(4598.68)
      expect(result.arSek).toBe(4520)
      expect(result.fxDiffSek).toBe(-78.68)
      expect(result.lines).toHaveLength(3)
      expect(result.lines[2]).toMatchObject({ account_number: '3960', credit_amount: 78.68 })
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })

    it('no FX line when the settlement-date value equals the booked value', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: 11300, currency: 'EUR', exchange_rate: 11.3 },
        { currency: 'EUR', exchange_rate: 11.3, remaining_amount: 1000, total: 1000, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.arSek).toBe(11300)
      expect(result.fxDiffSek).toBe(0)
      expect(result.lines).toHaveLength(2)
    })
  })

  describe('paymentAccount parameter (settlement-account resolution)', () => {
    it('defaults the bank leg to 1930 when paymentAccount is not passed (backward compat)', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1250, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1250, total: 1250, paid_amount: 0 },
        'Inbetalning kundfaktura',
      )
      expect(result.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 1250 })
    })

    it('books the bank leg to the resolved account when paymentAccount is passed', () => {
      const result = buildInvoicePaymentClearingLines(
        { amount: 1250, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1250, total: 1250, paid_amount: 0 },
        'Inbetalning kundfaktura',
        undefined,
        '1940',
      )
      expect(result.lines[0]).toMatchObject({ account_number: '1940', debit_amount: 1250 })
      // The AR leg (1510) is untouched by the payment-account override.
      expect(result.lines[1]).toMatchObject({ account_number: '1510', credit_amount: 1250 })
    })

    it('a non-1930 paymentAccount does not affect the FX-diff line', () => {
      // Cross-currency full clear: bank received more SEK than booked → 3960 gain.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1100, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'USD', exchange_rate: 10, remaining_amount: 100, total: 100, paid_amount: 0 },
        'desc',
        100,
        '1940',
      )
      expect(result.lines[0]).toMatchObject({ account_number: '1940', debit_amount: 1100 })
      const fxLine = result.lines.find((l) => l.account_number === '3960')
      expect(fxLine).toMatchObject({ credit_amount: 100 })
    })

    it('a non-1930 paymentAccount does not affect the öresavrundning (3740) line', () => {
      // Pure-SEK sub-krona short, same shape as the öresavrundning describe
      // block above, but resolved to a non-primary bank account.
      const result = buildInvoicePaymentClearingLines(
        { amount: 1000, amount_sek: null, currency: 'SEK', exchange_rate: null },
        { currency: 'SEK', exchange_rate: null, remaining_amount: 1000.25, total: 1000.25, paid_amount: 0 },
        'Inbetalning kundfaktura',
        undefined,
        '1940',
      )
      expect(result.lines.find((l) => l.account_number === '1940')?.debit_amount).toBe(1000)
      expect(result.lines.find((l) => l.account_number === '1930')).toBeUndefined()
      expect(result.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(1000.25)
      expect(result.lines.find((l) => l.account_number === '3740')?.debit_amount).toBe(0.25)
      const debit = result.lines.reduce((s, l) => s + l.debit_amount, 0)
      const credit = result.lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round((debit - credit) * 100)).toBe(0)
    })
  })
})
