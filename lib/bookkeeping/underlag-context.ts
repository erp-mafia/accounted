/**
 * What the underlag says, in the shape the proposal engines can use.
 *
 * The extraction already reads the supplier, the country and the line
 * items off every receipt and invoice. The proposal was computed from the
 * bank line alone, so a receipt that says "Circle K, Diesel 62,3 l" got the
 * proposal for "Kortköp K8781". This module carries the document's facts
 * into the counterparty matchers (which key on a merchant name) and the
 * keyword templates (which search text), without changing how either
 * scores.
 */
import type { InvoiceExtractionResult, Transaction } from '@/types'

export interface UnderlagContext {
  supplierName: string | null
  /** ISO 3166-1 alpha-2, when the extraction read one. */
  supplierCountry: string | null
  /** Line-item descriptions, at most a handful, in document order. */
  lineDescriptions: string[]
  merchantCategory: string | null
  documentKind: string | null
}

const MAX_LINE_DESCRIPTIONS = 8

export function underlagContextFrom(
  extracted: Partial<InvoiceExtractionResult> | null | undefined,
): UnderlagContext | null {
  if (!extracted || typeof extracted !== 'object') return null
  const supplierName = extracted.supplier?.name?.trim() || null
  const supplierCountry = extracted.supplier?.country?.trim().toUpperCase() || null
  const lineDescriptions = (extracted.lineItems ?? [])
    .map((l) => (l?.description ?? '').trim())
    .filter((d) => d.length > 0)
    .slice(0, MAX_LINE_DESCRIPTIONS)
  const merchantCategory = extracted.merchantCategory ?? null
  const documentKind = extracted.documentKind ?? null
  if (!supplierName && lineDescriptions.length === 0 && !merchantCategory) return null
  return { supplierName, supplierCountry, lineDescriptions, merchantCategory, documentKind }
}

/** The document's words, for the keyword templates' search text. */
export function underlagSearchText(ctx: UnderlagContext | null | undefined): string {
  if (!ctx) return ''
  return [ctx.supplierName ?? '', ...ctx.lineDescriptions].join(' ').trim()
}

/**
 * The transaction as the document names its counterparty.
 *
 * The counterparty matchers key on `merchant_name || original_description ||
 * description`, which for a card row is the bank's string. Substituting the
 * invoice's supplier name finds the template the company learned when it
 * booked that supplier's invoices, whatever the bank calls the card charge.
 * Nothing else about the transaction changes.
 */
export function withUnderlagAsCounterparty(tx: Transaction, ctx: UnderlagContext | null | undefined): Transaction {
  if (!ctx?.supplierName) return tx
  return { ...tx, merchant_name: ctx.supplierName }
}
