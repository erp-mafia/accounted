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
 */
const LEADING_NOISE = '(?:(?:19|20)\\d{2}[-_. ]+)?(?:ver(?:ifikat|ifikation)?[-_. ]*)?'

/** `A31`, `A-31`, `A_31`, `A 31`, optionally followed by `_`/`-`/space + anything. */
const SERIES_NUMBER_RE = new RegExp(
  `^${LEADING_NOISE}([A-Za-zÅÄÖåäö]{1,3})[-_. ]?(\\d{1,7})(?:[-_. ].*)?$`,
  'i',
)

/** `31`, `31_kvitto`. No year prefix accepted here: see parseVoucherRefFromFileName. */
const NUMBER_ONLY_RE = /^(\d{1,6})(?:[-_. ].*)?$/

/** `20240131...`, `2024-01-31...`: a date-named file, never a voucher number. */
const DATE_PREFIX_RE = /^(?:19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}/

/** Drop any directory part (drag-dropped folders carry a relative path). */
function baseName(fileName: string): string {
  const withoutDirs = fileName.split(/[/\\]/).pop() ?? fileName
  return withoutDirs.trim()
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
  if (numberMatch) {
    const number = Number(numberMatch[1])
    if (Number.isInteger(number) && number > 0) {
      return { series: null, number, pattern: 'number_only', autoSelectable: false }
    }
  }

  return null
}
