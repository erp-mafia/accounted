import type { InvoiceExtractionResult } from '@/types'

/**
 * What a person needs off an underlag to book its transaction: who, when,
 * how much, how much of it is moms. Read from the extraction the inbox
 * stored, tolerating the shapes older extractions have.
 */
export interface UnderlagFacts {
  supplier: string | null
  date: string | null
  total: number | null
  subtotal: number | null
  vat_amount: number | null
  currency: string | null
  kind: string | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

export function readUnderlagFacts(extracted: unknown): UnderlagFacts | null {
  if (!extracted || typeof extracted !== 'object') return null
  const e = extracted as Partial<InvoiceExtractionResult>
  const facts: UnderlagFacts = {
    supplier: e.supplier?.name ?? null,
    date: e.invoice?.invoiceDate ?? null,
    total: num(e.totals?.total),
    subtotal: num(e.totals?.subtotal),
    vat_amount: num(e.totals?.vatAmount),
    currency: e.invoice?.currency ?? null,
    kind: e.documentKind ?? null,
  }
  return Object.values(facts).every((v) => v == null) ? null : facts
}

/** What GET /api/transactions/[id]/underlag returns: the document from either door, and its facts. */
export interface TransactionUnderlag {
  source: 'pinned' | 'matched' | null
  document: { id: string; file_name: string | null; mime_type: string | null } | null
  inbox_item_id: string | null
  facts: UnderlagFacts | null
}

/**
 * Below this a receipt is still required by law, but asking for it before
 * every coffee is what makes people stop booking. Above it the review asks
 * the person to fetch the underlag before booking without one.
 */
export const UNDERLAG_PROMPT_THRESHOLD_SEK = 500

export function needsUnderlagPrompt(amountSek: number | null | undefined): boolean {
  return amountSek != null && Number.isFinite(amountSek) && Math.abs(amountSek) >= UNDERLAG_PROMPT_THRESHOLD_SEK
}

/** The document's moms and the proposed moms disagree by more than rounding. */
export function vatDisagrees(
  documentVat: number | null | undefined,
  proposedVat: number | null | undefined,
  toleranceSek = 1,
): boolean {
  if (documentVat == null || proposedVat == null) return false
  return Math.abs(documentVat - proposedVat) > toleranceSek
}
