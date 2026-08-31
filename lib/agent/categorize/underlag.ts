import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

/**
 * Gather the underlag (receipt / invoice text) matched to a transaction and
 * render it as compact text for the account selector.
 *
 * This is the highest-leverage input for the cold-start majority: without it
 * the model sees only the bank line (merchant + amount); with it, it sees the
 * supplier name, line items and VAT off the actual receipt. Same sources the
 * transaction.categorization intent reads — receipts.matched_transaction_id,
 * invoice_inbox_items.matched_transaction_id, and the transaction's own
 * attached document — but produced as a bounded string, not a tool loop.
 *
 * Company-scoped and best-effort: any failing query is skipped, never fatal.
 * Returns '' when there is no underlag (the selector then works off the bank
 * line + candidates as before).
 */

const MAX_UNDERLAG_CHARS = 2500
const MAX_LINE_ITEMS = 8

function fmt(amount: number | null | undefined, currency: string | null | undefined): string | null {
  if (amount === null || amount === undefined) return null
  return `${roundOre(Number(amount))} ${currency ?? 'SEK'}`
}

function lineItemDescriptions(ex: Record<string, unknown>): string[] {
  const items = ex.lineItems
  if (!Array.isArray(items)) return []
  const out: string[] = []
  for (const it of items.slice(0, MAX_LINE_ITEMS)) {
    const d = (it as { description?: unknown }).description
    if (typeof d === 'string' && d.trim()) out.push(d.trim())
  }
  return out
}

export async function gatherUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  documentId?: string | null,
): Promise<string> {
  const [receiptsRes, inboxRes, docRes] = await Promise.all([
    supabase
      .from('receipts')
      .select('merchant_name, receipt_date, total_amount, vat_amount, currency, is_restaurant, is_systembolaget')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', transactionId),
    supabase
      .from('invoice_inbox_items')
      .select('extracted_data')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', transactionId),
    documentId
      ? supabase
          .from('document_attachments')
          .select('extracted_data')
          .eq('id', documentId)
          .eq('company_id', companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]).catch(() => [{ data: null }, { data: null }, { data: null }] as const)

  const lines: string[] = []

  // Receipts (receipt-scan extracted fields).
  for (const r of ((receiptsRes as { data: unknown }).data ?? []) as {
    merchant_name: string | null
    receipt_date: string | null
    total_amount: number | null
    vat_amount: number | null
    currency: string | null
    is_restaurant: boolean | null
    is_systembolaget: boolean | null
  }[]) {
    const parts: string[] = []
    if (r.merchant_name) parts.push(r.merchant_name)
    if (r.receipt_date) parts.push(r.receipt_date)
    const total = fmt(r.total_amount, r.currency)
    if (total) parts.push(`totalt ${total}`)
    const vat = fmt(r.vat_amount, r.currency)
    if (vat) parts.push(`moms ${vat}`)
    if (r.is_restaurant) parts.push('restaurang/representation')
    if (r.is_systembolaget) parts.push('Systembolaget')
    if (parts.length) lines.push(`Kvitto: ${parts.join(', ')}.`)
  }

  // Invoice inbox items (structured extraction of an invoice/receipt).
  for (const it of ((inboxRes as { data: unknown }).data ?? []) as {
    extracted_data: Record<string, unknown> | null
  }[]) {
    const ex = it.extracted_data
    if (!ex) continue
    lines.push(renderExtraction(ex, 'Faktura/kvitto (inkorg)'))
  }

  // The transaction's own attached document.
  const doc = (docRes as { data: { extracted_data?: Record<string, unknown> | null } | null }).data
  if (doc?.extracted_data) lines.push(renderExtraction(doc.extracted_data, 'Bifogat underlag'))

  return lines.filter(Boolean).join('\n').slice(0, MAX_UNDERLAG_CHARS).trim()
}

function renderExtraction(ex: Record<string, unknown>, label: string): string {
  const supplier = (ex.supplier as { name?: string | null } | undefined) ?? null
  const invoice = (ex.invoice as { invoiceDate?: string | null; currency?: string | null } | undefined) ?? null
  const totals = (ex.totals as { total?: number | null; vatAmount?: number | null } | undefined) ?? null

  const parts: string[] = []
  if (supplier?.name) parts.push(`leverantör ${supplier.name}`)
  if (invoice?.invoiceDate) parts.push(invoice.invoiceDate)
  const total = fmt(totals?.total, invoice?.currency)
  if (total) parts.push(`totalt ${total}`)
  const vat = fmt(totals?.vatAmount, invoice?.currency)
  if (vat) parts.push(`moms ${vat}`)

  const items = lineItemDescriptions(ex)
  const head = `${label}: ${parts.join(', ') || 'utläst underlag'}.`
  return items.length ? `${head} Rader: ${items.map((d) => `"${d}"`).join('; ')}.` : head
}
