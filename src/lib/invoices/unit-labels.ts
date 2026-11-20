/**
 * Unit labels on customer-facing documents.
 *
 * `invoice_items.unit` is stored as the free-text string the user typed
 * (Swedish by default: the editor offers lib/invoices/units.ts
 * UNIT_SUGGESTIONS). An invoice rendered in English printed that Swedish unit
 * verbatim, so "1 st" sat next to "Description" and "Qty". This maps every
 * suggested unit that is a Swedish word to its English label at render time;
 * the ones that are already international (km, kg, m, l, m3) and anything a
 * user typed print as stored. Nothing is rewritten in the database or the API.
 *
 * A unit that is a written-out word also follows the quantity (crm#1480): the
 * stored unit is one word for every row, so "2 dag" and "2 day" were printed.
 * Abbreviations (st, tim, mån, km, h, pcs) never inflect.
 */

const EN_UNIT_LABELS: Record<string, string> = {
  st: 'pcs',
  tim: 'h',
  dag: 'day',
  månad: 'month',
  mån: 'month',
  vecka: 'week',
  år: 'year',
  // ASCII, like m3: a custom invoice font may have no superscript two.
  kvm: 'm2',
}

/**
 * Written-out units as [singular, plural], in the language of the word itself
 * (an imported "piece" on a Swedish invoice is still an English word). Words
 * that are the same in both numbers (år, meter, kilometer, ord) are not here.
 */
const WORD_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['dag', 'dagar'],
  ['månad', 'månader'],
  ['vecka', 'veckor'],
  ['timme', 'timmar'],
  ['day', 'days'],
  ['month', 'months'],
  ['week', 'weeks'],
  ['year', 'years'],
  ['hour', 'hours'],
  ['piece', 'pieces'],
]

/** Either form, lowercased, to both forms. */
const FORMS_BY_WORD: ReadonlyMap<string, readonly [string, string]> = new Map(
  WORD_FORMS.flatMap((forms) => [
    [forms[0], forms],
    [forms[1], forms],
  ]),
)

/**
 * The label in the number the quantity takes: singular for exactly one (or
 * minus one on a credit note), plural otherwise, 0 and 1,5 included ("0
 * dagar", "1.5 days"). A leading capital is kept.
 */
function inflect(label: string, quantity: number | null | undefined): string {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return label
  const word = label.trim()
  const forms = FORMS_BY_WORD.get(word.toLowerCase())
  if (!forms) return label
  const inflected = Math.abs(quantity) === 1 ? forms[0] : forms[1]
  const first = word.charAt(0)
  return first !== first.toLowerCase() ? inflected.charAt(0).toUpperCase() + inflected.slice(1) : inflected
}

/**
 * The unit as a document in `lang` prints it beside `quantity`. Without a
 * quantity the label is returned uninflected.
 */
export function unitLabel(
  unit: string | null | undefined,
  lang: 'sv' | 'en',
  quantity?: number | null,
): string {
  const raw = unit ?? ''
  const label = lang === 'en' ? (EN_UNIT_LABELS[raw.trim().toLowerCase()] ?? raw) : raw
  return inflect(label, quantity)
}
