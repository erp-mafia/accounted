/**
 * Riksbanken's exchange rate for a currency on a date, read on its own
 * through the MCP door: the same lookup every foreign-currency write books
 * with (lib/currency/riksbanken.ts, shared exchange_rates cache included),
 * so an agent can value a foreign amount at month end, an unbooked cost or
 * a check of a rate on an invoice, without a write that happens to look
 * one up. The app's forms read it through GET /api/currency/rate.
 *
 * Never an estimate: a day without a rate of its own (a weekend, a holiday,
 * today before Riksbanken publishes) answers the latest earlier observation
 * within the look-back with its own date, and no observation, or Riksbanken
 * refusing for the moment, is a typed reason, never a number.
 */
import { z } from 'zod'
import { fetchExchangeRate, isExchangeRateTemporarilyUnavailable } from '@/lib/currency/riksbanken'
import { RIKSBANKEN_CURRENCIES } from '@/lib/currency/riksbanken-currencies'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { defineOperation, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const CURRENCY = z
  .enum(RIKSBANKEN_CURRENCIES as [string, ...string[]])
  .describe('ISO 4217 code of a currency Riksbanken publishes a SEK rate for, e.g. EUR.')

export const exchangeRateOutputSchema = z.object({
  currency: z.string(),
  date: z.string().describe('The day asked for (YYYY-MM-DD).'),
  available: z.boolean().describe('True when Riksbanken has a rate for the day.'),
  rate: z.number().nullable().describe('SEK for one unit of the currency, Riksbanken\'s rate; null when not available.'),
  observation_date: z
    .string()
    .nullable()
    .describe(
      "The day of Riksbanken's observation: the day asked for, or the latest earlier one (weekend, holiday, today before " +
        'publication), at most 7 days back. Null when not available.',
    ),
  reason: z
    .enum(['temporarily_unavailable', 'no_rate'])
    .nullable()
    .describe(
      'Why there is no rate: temporarily_unavailable (Riksbanken refused or failed the request; ask again in a minute), no_rate ' +
        '(no observation within 7 days before the day: before the series starts, or after a closed series ends). Null when available.',
    ),
  source: z.literal('riksbanken'),
})

export type ExchangeRateOutput = z.infer<typeof exchangeRateOutputSchema>

export const exchangeRatesGet = defineOperation({
  id: 'exchange-rates.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: "Riksbanken's SEK rate for a currency on a date, the rate the books translate foreign amounts at.",
    description:
      "The rate in SEK for one unit of the currency from Riksbanken, the same lookup supplier invoices, bank rows and invoices in " +
      'a foreign currency are booked with. A day without its own observation (weekend, holiday, today before publication) answers ' +
      'the latest earlier one, at most 7 days back, with its observation_date. Reads only: nothing is booked or stored on the company.',
    useWhen:
      'You need a rate without writing anything: valuing an unbooked foreign cost or a foreign balance at month end, or checking ' +
      'the rate on a foreign invoice before registering it.',
    doNotUseFor:
      'Booking a foreign amount: the write tools look the rate up themselves for the document date. A rate for a day after today.',
    pitfalls: [
      'observation_date can be earlier than date: say which day the rate is from.',
      'reason temporarily_unavailable is Riksbanken refusing for the moment: ask again shortly, never use another number in its place.',
      'A date after today is refused: Riksbanken publishes no rate ahead.',
    ],
    example: {
      request: { currency: 'EUR', date: '2026-10-31' },
      response: {
        data: {
          currency: 'EUR',
          date: '2026-10-31',
          available: true,
          rate: 10.978,
          observation_date: '2026-10-30',
          reason: null,
          source: 'riksbanken',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    currency: CURRENCY,
    date: saneIsoDateSchema.optional().describe('The day (YYYY-MM-DD), not after today. Default: today in Sweden.'),
  }),
  output: exchangeRateOutputSchema,
  errorCodes: ['VALIDATION_ERROR', 'EXCHANGE_RATE_SANDBOX'],
  mcp: {
    name: 'gnubok_get_exchange_rate',
    title: 'Get Exchange Rate',
    description:
      "Riksbanken's SEK rate for one unit of a currency on a date, the rate foreign amounts are booked at. A day without its own " +
      'rate (weekend, holiday) answers the latest earlier one with its observation_date. Reads only.',
    visibility: 'search',
    keywords: [
      'valutakurs',
      'växelkurs',
      'riksbanken',
      'kurs',
      'valuta',
      'omräkning',
      'omräkningskurs',
      'exchange rate',
      'eur',
      'usd',
    ],
  },
  run: async (ctx, input): Promise<OperationOutcome<ExchangeRateOutput>> => {
    const day = input.date ?? todayIsoStockholm()
    if (day > todayIsoStockholm()) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'date', reason: 'after today' },
        messageSv: 'Datumet ligger efter i dag. Riksbanken publicerar ingen kurs i förväg.',
        messageEn: 'The date is after today. Riksbanken publishes no rate ahead.',
      }
    }
    // Riksbanken limits requests per IP: a demo company never spends that
    // budget, as on GET /api/currency/rate.
    if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'EXCHANGE_RATE_SANDBOX' }
    const found = await fetchExchangeRate(input.currency, new Date(`${day}T00:00:00Z`), ctx.supabase)
    if (!found) {
      return {
        ok: true,
        data: {
          currency: input.currency,
          date: day,
          available: false,
          rate: null,
          observation_date: null,
          reason: isExchangeRateTemporarilyUnavailable(input.currency) ? 'temporarily_unavailable' : 'no_rate',
          source: 'riksbanken',
        },
      }
    }
    return {
      ok: true,
      data: {
        currency: input.currency,
        date: day,
        available: true,
        rate: found.rate,
        observation_date: found.date,
        reason: null,
        source: 'riksbanken',
      },
    }
  },
})
