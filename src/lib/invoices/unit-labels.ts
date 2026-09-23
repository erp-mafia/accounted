/**
 * Unit labels on customer-facing documents.
 *
 * `invoice_items.unit` is stored as the free-text string the user typed
 * (Swedish by default: the editor offers st/tim/dag/månad/km/kg). An invoice
 * rendered in English printed that Swedish unit verbatim, so "1 st" sat next
 * to "Description" and "Qty". This maps the editor's known units to their
 * English label at render time; anything else (a user-typed unit we cannot
 * know) prints as stored. Nothing is rewritten in the database or the API.
 */

const EN_UNIT_LABELS: Record<string, string> = {
  st: 'pcs',
  tim: 'h',
  dag: 'day',
  månad: 'month',
  mån: 'month',
}

export function unitLabel(unit: string | null | undefined, lang: 'sv' | 'en'): string {
  const raw = unit ?? ''
  if (lang !== 'en') return raw
  const key = raw.trim().toLowerCase()
  return EN_UNIT_LABELS[key] ?? raw
}
