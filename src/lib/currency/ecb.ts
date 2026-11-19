import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'

const log = createLogger('ecb')

/**
 * ECB euro reference rates, for the one place the law names them: the OSS
 * declaration (unionsordningen) is made out in euro, and an amount in another
 * currency is converted at the rate the European Central Bank publishes for
 * the last day of the period, or, when it publishes none that day, on its
 * next day of publication (VAT Directive art. 369h(2); Skatteverket,
 * "Deklarera och betala moms i One Stop Shop").
 *
 * Bookkeeping rates stay Riksbanken's (riksbanken.ts). This module answers
 * one question: how many units of a currency one euro was on a given day.
 */

const ECB_EXR_URL = 'https://data-api.ecb.europa.eu/service/data/EXR'

/**
 * How far past the date the next publication is looked for. The longest gap
 * in the TARGET calendar is Good Friday to Easter Monday plus a weekend.
 */
const LOOKAHEAD_DAYS = 10

/** Never the Next.js data cache: a day with no rate yet must not stay cached as "none". */
const ECB_REQUEST: RequestInit = { headers: { Accept: 'text/csv' }, cache: 'no-store' }

const DAY_MS = 86_400_000

export interface EcbEuroRate {
  currency: string
  /** Units of `currency` per one euro. */
  rate: number
  /** The day the ECB published the rate: the date asked for, or its next day of publication. */
  date: string
}

/**
 * `rate` is null when the ECB has published nothing for the currency on or
 * after the date yet (a period not over, a currency it does not quote).
 * `ok: false` means the ECB could not be reached: a temporary state.
 */
export type EcbRateLookup = { ok: true; rate: EcbEuroRate | null } | { ok: false }

/** Settled answers only: a published rate never changes. */
const settled = new Map<string, EcbEuroRate>()

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The first observation on or after `onOrAfter` in an ECB csvdata answer
 * (detail=dataonly: KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,
 * TIME_PERIOD,OBS_VALUE). Columns are found by header name.
 */
export function parseEcbCsv(csv: string, currency: string, onOrAfter: string): EcbEuroRate | null {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) return null
  const header = lines[0].split(',')
  const dateCol = header.indexOf('TIME_PERIOD')
  const valueCol = header.indexOf('OBS_VALUE')
  if (dateCol < 0 || valueCol < 0) return null

  let first: EcbEuroRate | null = null
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const date = cells[dateCol]
    const rate = Number.parseFloat(cells[valueCol])
    if (!ISO_DATE_RE.test(date ?? '') || !Number.isFinite(rate) || rate <= 0) continue
    if (date < onOrAfter) continue
    if (!first || date < first.date) first = { currency, rate, date }
  }
  return first
}

/** Clears the settled-rate memo. */
export function resetEcbRatesForTests(): void {
  settled.clear()
}

/**
 * The ECB euro reference rate for `currency` on `date`, or on the ECB's next
 * day of publication after it. Euro itself is 1.
 */
export async function fetchEcbEuroRate(currency: string, date: string): Promise<EcbRateLookup> {
  const code = currency.toUpperCase()
  if (code === 'EUR') return { ok: true, rate: { currency: code, rate: 1, date } }
  if (!/^[A-Z]{3}$/.test(code) || !ISO_DATE_RE.test(date)) return { ok: true, rate: null }

  const key = `${code}:${date}`
  const memo = settled.get(key)
  if (memo) return { ok: true, rate: memo }

  const url =
    `${ECB_EXR_URL}/D.${code}.EUR.SP00.A` +
    `?startPeriod=${date}&endPeriod=${shiftDay(date, LOOKAHEAD_DAYS)}&detail=dataonly&format=csvdata`
  let response: Response
  try {
    response = await fetch(url, ECB_REQUEST)
  } catch (error) {
    log.warn('ECB rate request failed', { currency: code, date, reason: error instanceof Error ? error.message : String(error) })
    return { ok: false }
  }
  // 404: no series or no observation in the range. An answer, not a failure.
  if (response.status === 404) return { ok: true, rate: null }
  if (!response.ok) {
    log.warn('ECB rate request refused', { currency: code, date, status: response.status })
    return { ok: false }
  }

  const rate = parseEcbCsv(await response.text(), code, date)
  if (rate) settled.set(key, rate)
  return { ok: true, rate }
}
