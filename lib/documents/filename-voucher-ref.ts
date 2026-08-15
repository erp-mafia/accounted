/**
 * Read a source-system voucher reference out of an underlag filename.
 *
 * Systems that export receipts alongside a SIE file name each file after the
 * verifikat it belongs to: SpeedLedger writes `A31_<internal-uuid>.pdf`, Fortnox
 * `V123.pdf`, others `2024-A-31 kvitto.pdf`. That prefix is a deterministic
 * pointer into the ledger, which is why underlag import does not need to read
 * the document at all: no AI, no amount matching, no date windows.
 *
 * Design rule: an unrecognised name returns null. A wrong parse attaches
 * räkenskapsinformation to the wrong verifikat, and that cannot be undone
 * (BFL 7 kap), so the cost of guessing is far higher than the cost of asking.
 */

export type VoucherRefPattern =
  /** `A31`, `A31_uuid`, `A-31 kvitto`, `2024_A31`, `ver A31` */
  | 'series_number'
  /** `31`, `31_kvitto`: a number with no series at all. */
  | 'number_only'

export interface ParsedFileNameRef {
  /** Null when the filename carried a number but no series. */
  series: string | null
  number: number
  pattern: VoucherRefPattern
  /**
   * Whether this parse may be pre-selected in a bulk plan. Series-less parses
   * are never auto-selectable: `31.pdf` can point at any series, so a human
   * confirms even when the lookup happens to return a single candidate.
   */
  autoSelectable: boolean
}

/**
 * Optional noise ahead of the reference: a year folder prefix and the words
 * some exporters prepend. Kept tight on purpose, `(?:19|20)\d{2}` rather than
 * any 4 digits, so a voucher number is never eaten as a year.
 *
 * `ifikation` must precede `ifikat` in the alternation: regex alternation is
 * first-match, so the short branch would otherwise consume `Verifikat` out of
 * `Verifikation 31` and leave `ion` for the series group to swallow.
 */
const YEAR_NOISE = '(?:(?:19|20)\\d{2}[-_. ]+)?'
/**
 * The lookahead is load-bearing, not decoration. Without it the engine
 * backtracks into the shorter alternatives and `Verifikation 31` matches `ver`
 * + `ifikat`, leaving `ion` for the series group to swallow as series `ION`.
 * Requiring the word to end here means the prefix is either the whole word or
 * not consumed at all.
 */
const VER_NOISE = '(?:ver(?:ifikation|ifikat)?(?![A-Za-zÅÄÖåäö])[-_. ]*)?'

/** `A31`, `A-31`, `A_31`, `A 31`, optionally followed by `_`/`-`/space + anything. */
const SERIES_NUMBER_RE = new RegExp(
  `^${YEAR_NOISE}${VER_NOISE}([A-Za-zÅÄÖåäö]{1,3})[-_. ]?(\\d{1,7})(?:[-_. ].*)?$`,
  'i',
)

/**
 * `31`, `31_kvitto`, `Verifikat 31`. The `ver` prefix is allowed here but the
 * year prefix is NOT: `2024 31` is far more likely a date fragment than
 * voucher 31 of 2024, and this branch has no series to corroborate it with.
 */
const NUMBER_ONLY_RE = new RegExp(`^${VER_NOISE}(\\d{1,6})(?:[-_. ].*)?$`, 'i')

/**
 * A date-named file, never a voucher number. Deliberately loose where the
 * parser is strict: unpadded components (`2024-1-31`), two-digit years
 * (`24-01-31`), any of `-_. /` as separator, and the compact `20240131`.
 * A false positive here costs one manual assignment; a false negative attaches
 * a receipt to a verifikat whose number happens to equal a year fragment.
 */
const DATE_PREFIX_RE =
  /^(?:(?:19|20)\d{6}|(?:19|20)?\d{2}[-_. /]\d{1,2}[-_. /]\d{1,2})(?!\d)/

/**
 * Any four-digit run that reads as a calendar year. Used to refuse a
 * SERIES-LESS parse: `2024` alone is overwhelmingly a year, not verifikat 2024.
 */
const YEAR_LIKE_RE = /^(?:19|20)\d{2}$/

/**
 * Trim only. Directory components are NOT stripped: `file.name` from an
 * `<input type=file>` never carries a path, while the manual-reference box
 * feeds arbitrary user text through this same parser, where splitting on `/`
 * would quietly turn the typed date `2024/01/31` into voucher 31.
 */
function baseName(fileName: string): string {
  return fileName.trim()
}

/** Drop the extension, but only a real-looking one (`.pdf`, `.jpeg`). */
function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '')
}

export function parseVoucherRefFromFileName(fileName: string): ParsedFileNameRef | null {
  const stem = stripExtension(baseName(fileName))
  if (!stem) return null

  // A file named after its date is the single most common false positive: the
  // digits parse cleanly and point at a verifikat number that has nothing to do
  // with the receipt. Refuse the whole name rather than try to be clever.
  if (DATE_PREFIX_RE.test(stem)) return null

  const seriesMatch = SERIES_NUMBER_RE.exec(stem)
  if (seriesMatch) {
    const number = Number(seriesMatch[2])
    if (Number.isInteger(number) && number > 0) {
      return {
        series: seriesMatch[1].toUpperCase(),
        number,
        pattern: 'series_number',
        autoSelectable: true,
      }
    }
  }

  const numberMatch = NUMBER_ONLY_RE.exec(stem)
  if (numberMatch && !YEAR_LIKE_RE.test(numberMatch[1])) {
    const number = Number(numberMatch[1])
    if (Number.isInteger(number) && number > 0) {
      return { series: null, number, pattern: 'number_only', autoSelectable: false }
    }
  }

  return null
}
