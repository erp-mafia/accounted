/**
 * Which fields of an inbox item's reading a person corrected, and the rule
 * that keeps them: a new reading never overwrites a person's value.
 *
 * A field correction (updateInboxItemFields, lib/documents/inbox-item-actions.ts)
 * records the paths it wrote under extracted_data.personFields, beside the
 * reading. Every write that replaces the reading wholesale ("Tolka om", the
 * deferred first extraction, an agent's gnubok_set_inbox_extracted_data)
 * passes its new reading through keepPersonChoices, which copies those values
 * and the person's purchase category onto it. The one reading
 * (lib/documents/reading/resolve.ts) reads a marked field as the person's
 * (Ditt val) even where the new reading happens to agree with it.
 *
 * Pure except keepStoredPersonChoices, which reads the row for a writer that
 * has not.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { keepPersonPurchaseCategory } from '@/lib/categories/purchase-category-override'

/** The key on the reading that lists the paths a person corrected. */
export const PERSON_FIELDS_KEY = 'personFields'

/**
 * Every path a field correction can write, in the extraction shape
 * (InvoiceExtractionResult). Anything else under personFields is ignored.
 */
export const PERSON_FIELD_PATHS = [
  'documentKind',
  'supplier.name',
  'supplier.orgNumber',
  'supplier.vatNumber',
  'supplier.address',
  'supplier.bankgiro',
  'supplier.plusgiro',
  'invoice.invoiceNumber',
  'invoice.invoiceDate',
  'invoice.dueDate',
  'invoice.paymentReference',
  'invoice.creditedInvoiceNumber',
  'invoice.currency',
  'totals.subtotal',
  'totals.vatAmount',
  'totals.total',
] as const

export type PersonFieldPath = (typeof PERSON_FIELD_PATHS)[number]

const KNOWN_PATHS: ReadonlySet<string> = new Set(PERSON_FIELD_PATHS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The paths a person corrected on this reading, in PERSON_FIELD_PATHS order. */
export function personFieldPaths(reading: unknown): PersonFieldPath[] {
  if (!isRecord(reading)) return []
  const stored = reading[PERSON_FIELDS_KEY]
  if (!Array.isArray(stored)) return []
  const held = new Set(stored.filter((p): p is string => typeof p === 'string' && KNOWN_PATHS.has(p)))
  return PERSON_FIELD_PATHS.filter((p) => held.has(p))
}

/**
 * The paths a field correction writes: every key it names, a null (a cleared
 * field) included.
 */
export function correctionPaths(body: {
  documentKind?: unknown
  supplier?: Record<string, unknown>
  invoice?: Record<string, unknown>
  totals?: Record<string, unknown>
}): PersonFieldPath[] {
  const named = new Set<string>()
  if (body.documentKind !== undefined) named.add('documentKind')
  for (const group of ['supplier', 'invoice', 'totals'] as const) {
    const fields = body[group]
    if (!isRecord(fields)) continue
    for (const key of Object.keys(fields)) if (fields[key] !== undefined) named.add(`${group}.${key}`)
  }
  return PERSON_FIELD_PATHS.filter((p) => named.has(p))
}

/** The reading with `paths` added to the ones a person already corrected. Pure. */
export function withPersonFields<T extends object>(reading: T, paths: readonly PersonFieldPath[]): T {
  if (paths.length === 0) return reading
  const union = new Set<string>([...personFieldPaths(reading), ...paths])
  return { ...reading, [PERSON_FIELDS_KEY]: PERSON_FIELD_PATHS.filter((p) => union.has(p)) }
}

function valueAt(reading: Record<string, unknown>, path: PersonFieldPath): { held: boolean; value: unknown } {
  const [group, key] = path.split('.') as [string, string | undefined]
  if (key === undefined) return { held: group in reading, value: reading[group] }
  const parent = reading[group]
  return isRecord(parent) && key in parent ? { held: true, value: parent[key] } : { held: false, value: undefined }
}

/**
 * The replacement reading with every value a person corrected on the
 * previous reading copied over, and the list of those paths kept. A hand-set
 * total stays a verified total (totalSource null) and the amount due (no
 * prepaidAmount). Pure.
 */
export function keepPersonCorrections<T extends object>(previous: unknown, next: T): T {
  const paths = personFieldPaths(previous)
  if (paths.length === 0 || !isRecord(previous)) return next
  const out: Record<string, unknown> = { ...(next as Record<string, unknown>) }
  const kept: PersonFieldPath[] = []
  for (const path of paths) {
    const { held, value } = valueAt(previous, path)
    if (!held) continue
    const [group, key] = path.split('.') as [string, string | undefined]
    if (key === undefined) out[group] = value
    else out[group] = { ...(isRecord(out[group]) ? out[group] : {}), [key]: value }
    kept.push(path)
  }
  if (kept.includes('totals.total')) {
    out.totalSource = null
    // A person's total is the amount due (mergeInboxItemFields): a new reading's prepaid deduction does not apply to it.
    const totals = out.totals
    if (isRecord(totals) && totals.prepaidAmount != null) out.totals = { ...totals, prepaidAmount: null }
  }
  return withPersonFields(out as T, kept)
}

/**
 * Everything a person decided on the previous reading, carried onto its
 * replacement: the corrected fields and the purchase category. Pure.
 */
export function keepPersonChoices<T extends object>(previous: unknown, next: T): T {
  return keepPersonCorrections(previous, keepPersonPurchaseCategory(previous, next))
}

/** Whether keepPersonChoices carried a corrected field onto the replacement. */
export function carriedPersonFields(previous: unknown): boolean {
  return personFieldPaths(previous).length > 0
}

/**
 * keepPersonChoices for a writer that has not read the row: reads the item's
 * current reading first. A failed read carries nothing (the replacement goes
 * through as before) rather than failing the extraction.
 */
export async function keepStoredPersonChoices<T extends object>(
  supabase: SupabaseClient,
  itemId: string,
  companyId: string,
  next: T,
): Promise<{ reading: T; carriedFields: boolean }> {
  try {
    const { data, error } = await supabase
      .from('invoice_inbox_items')
      .select('extracted_data')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return { reading: next, carriedFields: false }
    const previous = (data as { extracted_data?: unknown } | null)?.extracted_data
    return { reading: keepPersonChoices(previous, next), carriedFields: carriedPersonFields(previous) }
  } catch {
    return { reading: next, carriedFields: false }
  }
}
