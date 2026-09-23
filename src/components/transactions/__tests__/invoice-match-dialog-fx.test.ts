import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  MATCH_INVOICE_BOOKING_RATE_MISSING,
  isInvoiceBookingRateMissing,
  previewedFxGainSek,
  type InvoiceBookingRateInput,
} from '../invoice-match-fx'

/**
 * The approval gate of the invoice-match dialog.
 *
 * The bug: the Valutaomräkning section computed its own kursvinst/kursförlust
 * from `potential_invoice.exchange_rate ?? 0` behind a `> 0` guard. An invoice
 * with no booked rate therefore previewed "no FX result", while the verifikat
 * built from the same screen posted a real gain (a 1 000 EUR invoice settled
 * by an 11 496,70 kr deposit produced a 10 496,70 kr kursvinst, because the
 * line builder fell back to rate 1). The user approved one number and got
 * another.
 *
 * buildInvoicePaymentClearingLines now throws
 * MATCH_INVOICE_BOOKING_RATE_MISSING instead of inventing the rate, and the
 * match-invoice preview GET and commit POST both surface that refusal, so the
 * dialog has to represent a refusal rather than a zero.
 *
 * The decision lives in ../invoice-match-fx.ts precisely so it can be tested:
 * this repo runs Vitest in the `node` environment and never renders
 * components, so a rule embedded in JSX is unverifiable by construction. These
 * tests therefore pin the helper's behaviour. Two file-level assertions remain
 * at the bottom for the two things a pure function cannot cover: that the
 * dialog no longer carries the defaulting expression that caused the bug, and
 * that the strings it renders exist in both locales.
 */

const base: InvoiceBookingRateInput = {
  transactionCurrency: 'SEK',
  invoiceCurrency: 'EUR',
  invoiceExchangeRate: 11.4967,
  previewEntryType: 'clearing',
  previewErrorCode: null,
}

describe('isInvoiceBookingRateMissing', () => {
  describe('state 1: no FX effect, nothing to warn about', () => {
    it('a pure SEK settlement is never a missing-rate case', () => {
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          transactionCurrency: 'SEK',
          invoiceCurrency: 'SEK',
          invoiceExchangeRate: null,
        }),
      ).toBe(false)
    })

    it('a foreign invoice settled in its own currency needs no booking rate', () => {
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          transactionCurrency: 'EUR',
          invoiceCurrency: 'EUR',
          invoiceExchangeRate: null,
        }),
      ).toBe(false)
    })

    it('a SEK invoice settled by a foreign bank transaction is bookable', () => {
      // fx_conversion.required is true here (the currencies differ), but the
      // line builder takes the !invoiceIsForeign branch, never reads
      // invoice.exchange_rate and posts no 3960/7960 line. SEK invoices always
      // have exchange_rate null, so keying off the rate alone would block
      // every one of these perfectly bookable settlements.
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          transactionCurrency: 'USD',
          invoiceCurrency: 'SEK',
          invoiceExchangeRate: null,
        }),
      ).toBe(false)
    })

    it('does not fire on the cash entry, which never values an AR leg', () => {
      // Kontantmetoden + unbooked + fully paid posts revenue and VAT directly;
      // 1510 is never touched, so no booking rate is consulted and the line
      // builder cannot throw.
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          invoiceExchangeRate: null,
          previewEntryType: 'cash',
        }),
      ).toBe(false)
    })
  })

  describe('state 2: foreign invoice with a booked rate', () => {
    it('is bookable, so the dialog previews a real kursvinst/kursförlust', () => {
      expect(isInvoiceBookingRateMissing(base)).toBe(false)
    })

    it('accepts rates across the whole valid band', () => {
      for (const rate of [0.0001, 1, 11.4967, 99999.9999]) {
        expect(isInvoiceBookingRateMissing({ ...base, invoiceExchangeRate: rate })).toBe(false)
      }
    })
  })

  describe('state 3: foreign invoice with no usable booked rate', () => {
    it('reports the settlement as unbookable', () => {
      expect(isInvoiceBookingRateMissing({ ...base, invoiceExchangeRate: null })).toBe(true)
    })

    it('treats an unusable stored rate the same as a missing one', () => {
      // Mirrors requireInvoiceBookingRate / the match_batch_allocate RPC
      // bound: 0 < rate < 100000. A rate outside it cannot value the 1510
      // credit, so it must not be smuggled through as a number.
      for (const rate of [0, -1, -11.4967, 100000, 1e9, Number.NaN, undefined, null]) {
        expect(isInvoiceBookingRateMissing({ ...base, invoiceExchangeRate: rate })).toBe(true)
      }
    })

    it('believes the server when the preview refused with the structured code', () => {
      // The live path: the preview GET 400s, so there is no entry_type and no
      // lines to reason about. The code alone must be enough.
      expect(
        isInvoiceBookingRateMissing({
          transactionCurrency: 'SEK',
          invoiceCurrency: 'EUR',
          invoiceExchangeRate: null,
          previewEntryType: null,
          previewErrorCode: MATCH_INVOICE_BOOKING_RATE_MISSING,
        }),
      ).toBe(true)
    })

    it('believes the code even when the client-side fields look fine', () => {
      // The server is authoritative: it built the lines with the same helper
      // the POST commits with. A stale or partial invoice row on the client
      // must never override a refusal that already happened.
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          previewErrorCode: MATCH_INVOICE_BOOKING_RATE_MISSING,
        }),
      ).toBe(true)
    })
  })

  describe('does not over-trigger', () => {
    it('ignores an unrelated preview failure', () => {
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          previewEntryType: null,
          previewErrorCode: 'MATCH_INVOICE_TX_FX_RATE_MISSING',
        }),
      ).toBe(false)
    })

    it('stays quiet while the preview is still in flight', () => {
      // Neither an entry type nor an error code yet: the dialog must not flash
      // a refusal panel before the server has said anything.
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          invoiceExchangeRate: null,
          previewEntryType: null,
          previewErrorCode: null,
        }),
      ).toBe(false)
    })

    it('does not guess when the invoice currency is unknown', () => {
      expect(
        isInvoiceBookingRateMissing({
          ...base,
          invoiceCurrency: null,
          invoiceExchangeRate: null,
        }),
      ).toBe(false)
    })
  })
})

describe('previewedFxGainSek', () => {
  const bank = { account_number: '1930', debit_amount: 11496.7, credit_amount: 0 }
  const ar = { account_number: '1510', debit_amount: 0, credit_amount: 11000 }

  it('reads a kursvinst off the previewed 3960 credit', () => {
    expect(
      previewedFxGainSek([
        bank,
        ar,
        { account_number: '3960', debit_amount: 0, credit_amount: 496.7 },
      ]),
    ).toBe(496.7)
  })

  it('reads a kursförlust off the previewed 7960 debit as a negative', () => {
    expect(
      previewedFxGainSek([
        bank,
        ar,
        { account_number: '7960', debit_amount: 496.7, credit_amount: 0 },
      ]),
    ).toBe(-496.7)
  })

  it('reports no FX result when the previewed entry has no 3960/7960 line', () => {
    expect(previewedFxGainSek([bank, ar])).toBe(0)
  })

  it('reports no FX result for an empty preview', () => {
    expect(previewedFxGainSek([])).toBe(0)
  })

  it('ignores öresavrundning (3740), which is not an FX result', () => {
    expect(
      previewedFxGainSek([
        bank,
        ar,
        { account_number: '3740', debit_amount: 0.3, credit_amount: 0 },
      ]),
    ).toBe(0)
  })

  it('surfaces the full gain the verifikat posts, however large', () => {
    // The reported case, had the server built lines for it: a 1 000 EUR
    // receivable valued at rate 1 against an 11 496,70 kr deposit books a
    // 10 496,70 kr kursvinst. The old screen recomputed its own figure and
    // showed 0. Reading the number off the previewed lines means the figure
    // approved is the figure booked, by construction.
    expect(
      previewedFxGainSek([
        { account_number: '1930', debit_amount: 11496.7, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        { account_number: '3960', debit_amount: 0, credit_amount: 10496.7 },
      ]),
    ).toBe(10496.7)
  })
})

describe('the dialog the helpers serve', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../InvoiceMatchDialog.tsx'), 'utf8')
  const readMessages = (locale: 'sv' | 'en') =>
    (
      JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
      ) as Record<string, Record<string, string>>
    ).tx_invoice_match

  it('never defaults a missing exchange rate to a number', () => {
    // The literal shape of the bug. A pure function cannot see this, and a
    // reviewer reintroducing it would otherwise get a green suite: every
    // helper test above would still pass while the dialog quietly recomputed
    // its own zero.
    expect(SRC).not.toMatch(/exchange_rate\s*(\?\?|\|\|)\s*-?\d/)
  })

  it('ships the missing-rate strings in both locales, with the currency placeholder', () => {
    // No repo-wide sv/en parity check exists, and a key present in only one
    // file renders its own name at the user.
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale)
      expect(messages.fx_invoice_rate_missing_title).toBeTruthy()
      expect(messages.fx_invoice_rate_missing_description).toBeTruthy()
      // next-intl throws on an unsupplied placeholder, so the parameter name
      // has to match what the dialog passes.
      expect(messages.fx_invoice_rate_missing_description).toContain('{invoiceCurrency}')
    }
  })
})
