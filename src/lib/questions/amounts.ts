/**
 * Money amounts written in a question, and whether each one stands on a
 * record the question rests on.
 *
 * An amount is a number with a currency beside it: "4 990 kr", "1.250,50 SEK",
 * "1,250.50 USD", "SEK 4 990", "3 miljoner kronor", "400 tkr". A number
 * without one (a year, a date, a percentage, an invoice number) is not read.
 *
 * A number is read by parseSwedishAmount (lib/money) once with the comma as
 * the decimal mark and once with the dot. Where both readings exist ("1,250")
 * the text is ambiguous and either reading counts.
 */
import { equalOre, multiplyOre, parseSwedishAmount, roundOre, roundToWholeKronor, truncateToWholeKronor } from '@/lib/money'

/** One reading of an amount as written. */
export interface AmountReading {
  /** The amount, never negative. */
  value: number
  /** Written with decimals: compared to the öre. Otherwise to the whole krona. */
  exact: boolean
}

export interface MoneyMention {
  /** The amount as written, unit included. */
  text: string
  /** Every way the number reads: two when the format is ambiguous. */
  readings: AmountReading[]
}

/** The spaces people and formatters put between thousands: space, no-break, narrow no-break, thin. */
const SP = '[ \\u00A0\\u202F\\u2009]'
/** Digits, space-grouped in threes or plain, with any dot or comma parts. */
const NUMBER = `(?:\\d{1,3}(?:${SP}\\d{3})+|\\d+)(?:[.,]\\d+)*`
/** Not inside a word or a longer number. */
const START = '(?<![\\p{L}\\p{N}])(?<!\\d[.,])'
const WORD_END = '(?![\\p{L}\\p{N}])'
/** Units that carry their own multiplier. */
const SCALED_UNIT = '(tkr|kkr|ksek|mkr|mnkr|msek)'
const SCALE_WORD = '(tusen|miljoner|miljon|miljarder|miljard|thousand|million|billion)'
const UNIT_WORD = '(?:kronor|krona|kr|sek|euro|eur|usd|dollar)'
/** Euro, dollar and pound signs. */
const UNIT_SIGN = '(?:\\u20AC|\\$|\\u00A3)'

const NUMBER_THEN_UNIT = `${START}(${NUMBER})(?:${SP}?${SCALED_UNIT}${WORD_END}|(?:${SP}${SCALE_WORD})?${SP}?(?:${UNIT_WORD}${WORD_END}|:-|${UNIT_SIGN}))`
const UNIT_THEN_NUMBER = `(?:(?<![\\p{L}\\p{N}])(?:sek|eur|usd)|${UNIT_SIGN})${SP}?(${NUMBER})(?!\\d)(?![-/]\\d)`
const MONEY = new RegExp(`${NUMBER_THEN_UNIT}|${UNIT_THEN_NUMBER}`, 'giu')

const SCALES: Readonly<Record<string, number>> = {
  tkr: 1_000,
  kkr: 1_000,
  ksek: 1_000,
  tusen: 1_000,
  thousand: 1_000,
  mkr: 1_000_000,
  mnkr: 1_000_000,
  msek: 1_000_000,
  miljon: 1_000_000,
  miljoner: 1_000_000,
  million: 1_000_000,
  miljard: 1_000_000_000,
  miljarder: 1_000_000_000,
  billion: 1_000_000_000,
}

function readingsOf(numberText: string, scale: number): AmountReading[] {
  const readings: AmountReading[] = []
  for (const mark of [',', '.'] as const) {
    const parsed = parseSwedishAmount(numberText, mark)
    if (parsed === null) continue
    // A scaled amount ("1,2 mkr") is a round figure: read to the whole krona.
    const exact = scale === 1 && numberText.includes(mark)
    const scaled = Math.abs(scale === 1 ? parsed : multiplyOre(parsed, scale))
    const value = exact ? scaled : roundToWholeKronor(scaled)
    if (!readings.some((r) => r.value === value && r.exact === exact)) readings.push({ value, exact })
  }
  return readings
}

/** Every money amount written in the text, in order. */
export function findMoneyMentions(text: string): MoneyMention[] {
  const mentions: MoneyMention[] = []
  for (const match of text.matchAll(MONEY)) {
    const numberText = match[1] ?? match[4]
    if (!numberText) continue
    const scaleWord = (match[2] ?? match[3])?.toLowerCase()
    const readings = readingsOf(numberText, scaleWord ? SCALES[scaleWord] ?? 1 : 1)
    if (readings.length > 0) mentions.push({ text: match[0].trim(), readings })
  }
  return mentions
}

/**
 * Whether the amount equals one of `amounts`: to the öre when it is written
 * with decimals, else to the whole krona (rounded or with the öre dropped).
 * Signs are ignored on both sides.
 */
export function isAmountAmong(mention: MoneyMention, amounts: readonly number[]): boolean {
  return mention.readings.some((reading) =>
    amounts.some((amount) => {
      if (!Number.isFinite(amount)) return false
      const known = Math.abs(roundOre(amount))
      if (reading.exact) return equalOre(known, reading.value)
      return roundToWholeKronor(known) === reading.value || truncateToWholeKronor(known) === reading.value
    }),
  )
}

/** The amounts written in `texts` that equal none of `amounts`, as written, each once. */
export function amountsNotAmong(texts: ReadonlyArray<string | null | undefined>, amounts: readonly number[]): string[] {
  const missing: string[] = []
  for (const text of texts) {
    if (!text) continue
    for (const mention of findMoneyMentions(text)) {
      if (!isAmountAmong(mention, amounts) && !missing.includes(mention.text)) missing.push(mention.text)
    }
  }
  return missing
}
