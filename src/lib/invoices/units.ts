/**
 * The unit vocabulary offered on article and invoice lines.
 *
 * These are SUGGESTIONS, not validation. `unit` is stored as free text (all
 * four tables declare it `text`) and the API accepts any non-empty string up
 * to 32 characters (lib/api/schemas.ts), so a customer who sells fuel picks
 * "l" and one who sells something we do not list types it under "Annan
 * enhet" without a code change. The list exists only so the common units are
 * one click away, and so the places that offer them cannot drift apart again:
 * before this module the same six strings were pasted into ArticleForm,
 * InvoiceEditor and NewRecurringScheduleDialog, and a closed dropdown also
 * made a unit that was stored by any other route (API, CSV import, MCP)
 * unreachable in the UI.
 *
 * Adding an entry here is enough for every surface. Three things must follow
 * it, and __tests__/units.test.ts pins all three:
 * - lib/invoices/peppol-bis-billing.ts needs a UN/ECE Rec 20 code for the
 *   unit, or a unit we suggested would fail the Peppol export with
 *   UNIT_UNSUPPORTED;
 * - UNIT_NAMES below needs its plain name, which the picker prints beside it;
 * - lib/invoices/unit-labels.ts needs an English label when the code is a
 *   Swedish word, or an English invoice prints it verbatim.
 *
 * Ordered by how often the unit is used, so the picker reads top down. The
 * square metre is "kvm", not "m2" or "m²": that is the spelling Swedish
 * invoices already carry, and it needs no superscript a custom PDF font may
 * lack.
 *
 * The codes stay Swedish in both locales: they are invoice data, not UI
 * chrome. lib/invoices/unit-labels.ts translates them at render time on an
 * English document.
 */
export const UNIT_SUGGESTIONS = [
  'st',
  'tim',
  'dag',
  'månad',
  'km',
  'kg',
  'm',
  'kvm',
  'år',
  'l',
  'm3',
  'vecka',
] as const

export type UnitSuggestion = (typeof UNIT_SUGGESTIONS)[number]

/** Mirrors `unit`'s max length in lib/api/schemas.ts, so the input cannot produce a 400. */
export const UNIT_MAX_LENGTH = 32

/**
 * The plain name the unit picker prints beside each code ("st  styck"), so a
 * user who does not know the abbreviation still finds the unit. UI chrome,
 * so it follows the interface language, unlike the code itself.
 */
export const UNIT_NAMES: Record<UnitSuggestion, { sv: string; en: string }> = {
  st: { sv: 'styck', en: 'pieces' },
  tim: { sv: 'timmar', en: 'hours' },
  dag: { sv: 'dagar', en: 'days' },
  'månad': { sv: 'månader', en: 'months' },
  km: { sv: 'kilometer', en: 'kilometres' },
  kg: { sv: 'kilogram', en: 'kilograms' },
  m: { sv: 'meter', en: 'metres' },
  kvm: { sv: 'kvadratmeter', en: 'square metres' },
  'år': { sv: 'år', en: 'years' },
  l: { sv: 'liter', en: 'litres' },
  m3: { sv: 'kubikmeter', en: 'cubic metres' },
  vecka: { sv: 'veckor', en: 'weeks' },
}

export function isUnitSuggestion(unit: string): unit is UnitSuggestion {
  return (UNIT_SUGGESTIONS as readonly string[]).includes(unit)
}

/**
 * The name printed beside a code in the picker, or null when there is none to
 * print: a unit we do not suggest, or a name that only repeats the code
 * ("år  år").
 */
export function unitName(unit: string, locale: string): string | null {
  if (!isUnitSuggestion(unit)) return null
  const name = UNIT_NAMES[unit][locale === 'en' ? 'en' : 'sv']
  return name === unit ? null : name
}

/**
 * The codes the picker lists for a field holding `current`. Always the whole
 * suggestion list, whatever the field holds: the native datalist this
 * replaced filtered its options by the input's value, so a row holding "st"
 * only ever offered "st". A stored unit we do not suggest (an import's "pkt")
 * goes first, so it shows as the current choice; `earlier` carries such a
 * unit the field held before, so it can be picked back after trying another.
 */
export function unitPickerOptions(
  current: string | null | undefined,
  earlier: readonly string[] = [],
): string[] {
  const custom: string[] = []
  for (const candidate of [current ?? '', ...earlier]) {
    const unit = candidate.trim()
    if (unit !== '' && !isUnitSuggestion(unit) && !custom.includes(unit)) custom.push(unit)
  }
  return [...custom, ...UNIT_SUGGESTIONS]
}

/**
 * What the picker's "Annan enhet" field commits: trimmed, inner whitespace
 * collapsed, capped at UNIT_MAX_LENGTH. Empty means nothing to commit.
 */
export function normalizeCustomUnit(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, UNIT_MAX_LENGTH).trim()
}
