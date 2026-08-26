/**
 * Putting a foreign receipt into kronor so it can be compared at all.
 *
 * Swedish banks post a converted SEK figure for a card purchase abroad, and
 * the receipt states the original: Anthropic bills 180,00 EUR and the
 * statement reads -2 014,32 kr. Neither number appears in the other document,
 * so the matcher has always refused the pair rather than guess. On a
 * SaaS-heavy ledger that is not an edge case: measured on a real company, 14
 * of 25 fetched receipts were in USD or EUR and none of them could ever pair.
 *
 * The conversion is deliberately not a match on its own. It fills in the one
 * missing number and hands the pair back to the same matcher, which still
 * wants the merchant and the date to agree, and still applies its own
 * tolerance. That tolerance is what absorbs the difference between
 * Riksbanken's mid rate and what a card issuer actually charged: measured
 * against real statements, Supabase came out 1.22% off and Vercel 1.23%,
 * comfortably inside the 5% the matcher already allows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { convertToSEK, fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import type { HuntPoolItem } from './select'

const log = createLogger('receipt-hunt-fx')

/** Currencies Riksbanken publishes a series for. */
const SUPPORTED = new Set(['EUR', 'USD', 'GBP', 'NOK', 'DKK', 'CHF', 'JPY', 'PLN'])

interface Signals {
  currency: string
  total: number | null
  date: string | null
}

function signalsOf(item: HuntPoolItem): Signals {
  const data = item.extracted_data as
    | {
        invoice?: { currency?: string | null; invoiceDate?: string | null }
        totals?: { total?: number | null }
      }
    | null
    | undefined
  return {
    currency: (data?.invoice?.currency || 'SEK').toUpperCase(),
    total: data?.totals?.total ?? null,
    date: data?.invoice?.invoiceDate ?? null,
  }
}

/**
 * Resolve a SEK total for every pool item stated in another currency.
 *
 * Rates are fetched once per currency and day and reused, because Riksbanken
 * answers 429 to a caller that asks per document, and a run can hold a dozen
 * receipts from the same vendor in the same month.
 *
 * An item whose rate cannot be resolved is returned untouched, which leaves it
 * exactly as incomparable as it was before: the hunt loses nothing it had.
 */
export async function attachSekTotals(
  supabase: SupabaseClient,
  pool: readonly HuntPoolItem[],
): Promise<HuntPoolItem[]> {
  const rates = new Map<string, number | null>()

  const rateFor = async (currency: string, date: string | null): Promise<number | null> => {
    // No date, no conversion. Reaching for today's rate would put a receipt
    // whose age nobody knows into amount matching on the strength of a guess,
    // and a rate two years out is how an incomparable receipt becomes a
    // confident wrong pairing.
    if (!date) return null

    // Riksbanken publishes per day, so the day is the whole cache key.
    const day = date
    const key = `${currency}::${day}`
    if (rates.has(key)) return rates.get(key) ?? null

    try {
      const rate = await fetchExchangeRate(currency as never, new Date(day), supabase as never)
      rates.set(key, rate?.rate ?? null)
      return rate?.rate ?? null
    } catch (error) {
      log.warn('could not resolve an exchange rate', {
        currency,
        day,
        error: error instanceof Error ? error.message : String(error),
      })
      rates.set(key, null)
      return null
    }
  }

  const out: HuntPoolItem[] = []
  let converted = 0

  for (const item of pool) {
    const sig = signalsOf(item)
    if (sig.currency === 'SEK' || sig.total == null || !SUPPORTED.has(sig.currency)) {
      out.push(item)
      continue
    }

    const rate = await rateFor(sig.currency, sig.date)
    if (rate == null) {
      out.push(item)
      continue
    }

    converted++
    out.push({
      ...item,
      // Öre, like every other money value here: a raw float would put
      // 1015.9700000000001 into a comparison against a bank amount.
      sek_total: roundOre(convertToSEK(sig.total, rate)),
    })
  }

  if (converted > 0) {
    log.info('resolved foreign receipt totals', { converted, rates: rates.size })
  }
  return out
}
