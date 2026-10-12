import { roundOre } from '@/lib/money'
import type { BankLineFinal } from './classify'

/**
 * How one decision on an inbox item (an underlag) is written to
 * suggestion_log. The suggestion is the model's original extraction of the
 * document; the decision is what was registered or booked from it, or the
 * item's deletion. Pure, so every inbox door classifies the same way.
 *
 * Outcome:
 *   - accepted:  booked from the extraction with no compared field changed.
 *   - changed:   booked from the extraction, with at least one field changed.
 *   - manual:    booked with no extraction to start from (none, or it failed).
 *   - dismissed: the item was deleted.
 */

/** The fields compared between the extraction and the booking. */
export interface InboxFields {
  supplier_name?: string | null
  supplier_org_number?: string | null
  invoice_number?: string | null
  invoice_date?: string | null
  due_date?: string | null
  payment_reference?: string | null
  currency?: string | null
  total?: number | null
  vat_amount?: number | null
  /** Result accounts (BAS classes 3-8), sorted and unique. */
  accounts?: string[]
}

export interface InboxFinal {
  supplier_invoice_id: string | null
  journal_entry_id: string | null
  fields: InboxFields
  lines: BankLineFinal['lines']
  /** The compared fields whose booked value differs from the extraction. */
  changed_fields: Array<keyof InboxFields>
}

export interface InboxSuggestion {
  source: 'extraction'
  source_id: string
  rank: 0
  proposal: { fields: InboxFields; suggested_template_id: string | null }
  confidence: number | null
  model: string | null
  prompt_sha256: null
  matches_final: boolean
}

/** Result accounts only: what the booking is about, not its bank, VAT or liability legs. */
export function resultAccounts(accounts: Array<string | null | undefined>): string[] {
  return [...new Set(accounts.filter((a): a is string => !!a && /^[3-8]\d{3}$/.test(a)))].sort()
}

/**
 * The total and VAT a verifikat books, for doors that post lines rather than
 * an invoice (book-direct). The total is the larger side once VAT is set
 * aside: the gross a purchase pays (VAT sits with the cost on the debit
 * side) and the gross a sale takes in, and for a reverse charge neither side
 * counts the self-assessed VAT pair.
 */
export function bookedTotals(lines: BankLineFinal['lines']): InboxFields {
  const nonVat = lines.filter((l) => !l.account.startsWith('26'))
  const vat = lines.filter((l) => l.account.startsWith('26'))
  const debit = nonVat.reduce((sum, l) => sum + l.debit, 0)
  const credit = nonVat.reduce((sum, l) => sum + l.credit, 0)
  return {
    total: roundOre(Math.max(debit, credit)),
    vat_amount: roundOre(Math.abs(vat.reduce((sum, l) => sum + l.debit - l.credit, 0))),
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The compared fields as the model read them. */
export function fieldsFromExtraction(extraction: unknown): InboxFields {
  const e = (extraction ?? {}) as {
    supplier?: { name?: unknown; orgNumber?: unknown }
    invoice?: { invoiceNumber?: unknown; invoiceDate?: unknown; dueDate?: unknown; paymentReference?: unknown; currency?: unknown }
    totals?: { total?: unknown; vatAmount?: unknown }
    lineItems?: Array<{ accountSuggestion?: unknown }>
  }
  const suggested = resultAccounts((e.lineItems ?? []).map((l) => str(l?.accountSuggestion)))
  return {
    supplier_name: str(e.supplier?.name),
    supplier_org_number: str(e.supplier?.orgNumber),
    invoice_number: str(e.invoice?.invoiceNumber),
    invoice_date: str(e.invoice?.invoiceDate),
    due_date: str(e.invoice?.dueDate),
    payment_reference: str(e.invoice?.paymentReference),
    currency: str(e.invoice?.currency),
    total: num(e.totals?.total),
    vat_amount: num(e.totals?.vatAmount),
    // No suggestion at all is "not compared", not "suggested nothing".
    ...(suggested.length > 0 ? { accounts: suggested } : {}),
  }
}

function normalize(key: keyof InboxFields, v: unknown): unknown {
  if (v == null) return null
  switch (key) {
    case 'total':
    case 'vat_amount':
      return roundOre(Number(v))
    case 'accounts':
      return (v as string[]).join(',')
    case 'supplier_org_number':
    case 'payment_reference':
      return String(v).replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null
    default:
      return String(v).trim().replace(/\s+/g, ' ').toUpperCase() || null
  }
}

/**
 * The fields the booking set that differ from the extraction. A field the
 * booking does not state (undefined) is not compared; one the model missed
 * and the person filled in counts as changed.
 */
export function changedFields(original: InboxFields, booked: InboxFields): Array<keyof InboxFields> {
  const keys = Object.keys(booked) as Array<keyof InboxFields>
  return keys.filter(
    (key) => booked[key] !== undefined && original[key] !== undefined && normalize(key, original[key]) !== normalize(key, booked[key]),
  )
}

export function classifyInboxDecision(input: {
  /** The model's original reading; null when there is none or it failed. */
  extraction: unknown | null
  model: string | null
  /** Stable id of the reading: the document, else the inbox item. */
  sourceId: string
  /** Null when the item was deleted. */
  booked: Omit<InboxFinal, 'changed_fields'> | null
}): { suggestions: InboxSuggestion[]; acted_on: number | null; outcome: 'accepted' | 'changed' | 'manual' | 'dismissed'; final: InboxFinal | null } {
  const original = input.extraction ? fieldsFromExtraction(input.extraction) : null
  const final: InboxFinal | null = input.booked
    ? { ...input.booked, changed_fields: original ? changedFields(original, input.booked.fields) : [] }
    : null
  const suggestions: InboxSuggestion[] = original
    ? [{
        source: 'extraction',
        source_id: input.sourceId,
        rank: 0,
        proposal: {
          fields: original,
          suggested_template_id: str((input.extraction as { suggestedTemplateId?: unknown }).suggestedTemplateId),
        },
        confidence: num((input.extraction as { confidence?: unknown }).confidence),
        model: input.model,
        prompt_sha256: null,
        matches_final: final !== null && final.changed_fields.length === 0,
      }]
    : []

  if (!final) return { suggestions, acted_on: null, outcome: 'dismissed', final: null }
  if (suggestions.length === 0) return { suggestions, acted_on: null, outcome: 'manual', final }
  return { suggestions, acted_on: 0, outcome: final.changed_fields.length === 0 ? 'accepted' : 'changed', final }
}
