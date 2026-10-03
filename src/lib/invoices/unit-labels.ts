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

export function unitLabel(unit: string | null | undefined, lang: 'sv' | 'en'): string {
  const raw = unit ?? ''
  if (lang !== 'en') return raw
  const key = raw.trim().toLowerCase()
  return EN_UNIT_LABELS[key] ?? raw
}
