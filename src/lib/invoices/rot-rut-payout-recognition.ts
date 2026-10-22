/**
 * Bokslutsmetodens second step at Skatteverket's payout: which invoices of a
 * begäran still have their deduction share unbooked, and the försäljning and
 * utgående moms the payout books for them.
 *
 * Under kontantmetoden the customer's payment books only the customer's
 * share (buildInvoiceCashLines with deferDeductionShare): the deduction is a
 * fordran kontantmetoden does not book, so it is received, and its moms
 * reported, when Skatteverket pays (ML 2023:200 7 kap. 16 §; Skatteverket,
 * "Så fungerar rotavdraget": "När företaget har fått utbetalningen för
 * rotavdrag från Skatteverket ska företaget redovisa resterande moms").
 * The payout voucher then credits that share's revenue and moms instead of
 * 1513, for what Skatteverket paid on each invoice: a beslut that approves
 * less books less, and the refused rest is simply never booked as
 * Skatteverket's (the customer owes it).
 *
 * An invoice's share is unbooked (deferred) only on positive evidence: the
 * company is on kontantmetoden, the invoice has no verifikat link of its own
 * (a year-end carry or a registration would have put the share on 1513), it
 * has a live kontantmetod payment verifikat, and none of its payment
 * verifikat carries a 1513 line (one booked before the two steps did, and
 * its payout clears 1513 as always). A payment verifikat dated before the
 * payout's räkenskapsår also keeps the 1513 path: the share was an unpaid
 * fordran at that year's end, which the year-end carry books on 1513
 * (kontantmetod-cutoff), so the payout clears it there.
 *
 * Reads only, client-safe (the payout dialog previews with it).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput, EntityType, Invoice, InvoiceItem } from '@/types'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { buildDeductionRecognitionLines, splitDeductionShare } from '@/lib/bookkeeping/invoice-lines'
import { ROT_RUT_RECEIVABLE_ACCOUNT } from '@/lib/invoices/apply-invoice-payment'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'

/** The part of one begäran's payout booked as revenue and moms, not against 1513. */
export interface PayoutRecognition {
  /** Kronor of the leg's amount the lines below carry (moms included). */
  amount: number
  /** Credit lines: the deduction share's försäljning and utgående moms. */
  lines: CreateJournalEntryLineInput[]
  /** The invoices recognised, with what Skatteverket paid on each. */
  invoices: Array<{ invoiceId: string; paid: number }>
}

export type PayoutRecognitionResult =
  | { ok: true; recognition: PayoutRecognition | null }
  | { ok: false; code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN'; details: Record<string, unknown> }
  | { ok: false; error: unknown }

interface RequestItemRow {
  invoice_id: string
  requested_amount: number | string
  decided_amount: number | string | null
}

type InvoiceRow = Pick<
  Invoice,
  'id' | 'invoice_number' | 'currency' | 'exchange_rate' | 'vat_treatment' | 'delivery_country' | 'journal_entry_id'
> & {
  subtotal: number
  vat_amount: number
  total: number
  default_dimensions?: Record<string, string> | null
  items?: InvoiceItem[] | null
}

interface EntryRow {
  id: string
  status: string
  reversed_by_id: string | null
  source_type: string | null
  entry_date: string
}

const CASH_PAYMENT_SOURCE = 'invoice_cash_payment'

/**
 * The invoices whose own payment verifikat left Skatteverket's share
 * unbooked (the positive evidence in the module comment): no verifikat link,
 * a live kontantmetod payment verifikat, no 1513 line on any of them, and
 * with `notBefore` none dated before it.
 */
async function invoicesWithUnbookedShare(
  supabase: SupabaseClient,
  companyId: string,
  invoices: ReadonlyArray<{ id: string; journal_entry_id?: string | null }>,
  notBefore: string | null,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: unknown }> {
  const unlinked = invoices.filter((invoice) => !invoice.journal_entry_id).map((invoice) => invoice.id)
  if (unlinked.length === 0) return { ok: true, ids: new Set() }
  const { data: payments, error: paymentsError } = await supabase
    .from('invoice_payments')
    .select('invoice_id, journal_entry_id')
    .in('invoice_id', unlinked)
    .not('journal_entry_id', 'is', null)
  if (paymentsError) return { ok: false, error: paymentsError }

  const vouchersByInvoice = new Map<string, string[]>()
  for (const payment of (payments ?? []) as Array<{ invoice_id: string; journal_entry_id: string }>) {
    vouchersByInvoice.set(payment.invoice_id, [...(vouchersByInvoice.get(payment.invoice_id) ?? []), payment.journal_entry_id])
  }
  const voucherIds = [...new Set([...vouchersByInvoice.values()].flat())]
  const live = new Map<string, EntryRow>()
  const with1513 = new Set<string>()
  if (voucherIds.length > 0) {
    const { data: entries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('id, status, reversed_by_id, source_type, entry_date')
      .eq('company_id', companyId)
      .in('id', voucherIds)
    if (entriesError) return { ok: false, error: entriesError }
    for (const entry of (entries ?? []) as EntryRow[]) {
      if (entry.status === 'posted' && !entry.reversed_by_id) live.set(entry.id, entry)
    }
    if (live.size > 0) {
      const { data: lines, error: linesError } = await supabase
        .from('journal_entry_lines')
        .select('journal_entry_id')
        .in('journal_entry_id', [...live.keys()])
        .eq('account_number', ROT_RUT_RECEIVABLE_ACCOUNT)
      if (linesError) return { ok: false, error: linesError }
      for (const line of (lines ?? []) as Array<{ journal_entry_id: string }>) with1513.add(line.journal_entry_id)
    }
  }

  const ids = new Set<string>()
  for (const invoiceId of unlinked) {
    const own = (vouchersByInvoice.get(invoiceId) ?? []).map((id) => live.get(id)).filter((e): e is EntryRow => !!e)
    if (!own.some((entry) => entry.source_type === CASH_PAYMENT_SOURCE)) continue
    if (own.some((entry) => with1513.has(entry.id) || (notBefore !== null && entry.entry_date < notBefore))) continue
    ids.add(invoiceId)
  }
  return { ok: true, ids }
}

/**
 * Whether a kreditfaktura of this kontantmetod invoice reverses only the
 * customer's share: its payment booked the first step alone and no payout
 * has booked Skatteverket's share yet (no settled begäran holds it), so the
 * share's revenue, moms and 1513 are not in the ledger to reverse. Once a
 * payout booked the share, the credit reverses it all and its 1513 credit is
 * what the company owes Skatteverket back. The caller checks that the company
 * is on kontantmetoden.
 */
export async function isDeductionShareUnbooked(
  supabase: SupabaseClient,
  companyId: string,
  invoice: { id: string; journal_entry_id?: string | null },
): Promise<{ ok: true; unbooked: boolean } | { ok: false; error: unknown }> {
  const evidence = await invoicesWithUnbookedShare(supabase, companyId, [invoice], null)
  if (!evidence.ok) return evidence
  if (!evidence.ids.has(invoice.id)) return { ok: true, unbooked: false }
  const { data, error } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, request:rot_rut_payout_requests(status, settlement_journal_entry_id)')
    .eq('invoice_id', invoice.id)
  if (error) return { ok: false, error }
  const settled = ((data ?? []) as Array<Record<string, unknown>>).some((row) => {
    const value = Array.isArray(row.request) ? row.request[0] : row.request
    const request = value as { status?: string; settlement_journal_entry_id?: string | null } | null
    return !!request?.settlement_journal_entry_id && !['cancelled', 'rejected'].includes(request.status ?? '')
  })
  return { ok: true, unbooked: !settled }
}

/**
 * What Skatteverket paid on each invoice of the begäran: the requested
 * amounts when it paid the request in full, the one invoice's when there is
 * one, the beslut's per-invoice amounts when they add up to the payout.
 * Null when the split is Skatteverket's and unknown (a total recorded by
 * hand for several invoices): never guessed.
 */
function paidPerInvoice(
  items: RequestItemRow[],
  requestedTotal: number,
  paidAmount: number,
): Map<string, number> | null {
  const paid = new Map<string, number>()
  if (items.length === 1) {
    paid.set(items[0].invoice_id, paidAmount)
    return paid
  }
  if (paidAmount >= requestedTotal) {
    for (const item of items) paid.set(item.invoice_id, roundOre((paid.get(item.invoice_id) ?? 0) + Number(item.requested_amount)))
    return equalOre(sumOre([...paid.values()]), paidAmount) ? paid : null
  }
  if (items.some((item) => item.decided_amount == null)) return null
  for (const item of items) paid.set(item.invoice_id, roundOre((paid.get(item.invoice_id) ?? 0) + Number(item.decided_amount)))
  return equalOre(sumOre([...paid.values()]), paidAmount) ? paid : null
}

export async function getPayoutRecognition(
  supabase: SupabaseClient,
  companyId: string,
  request: { id: string; requested_total: number | string },
  paidAmount: number,
  paymentDate: string,
): Promise<PayoutRecognitionResult> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, error: settingsError }
  if ((settings as { accounting_method?: string | null } | null)?.accounting_method !== 'cash') {
    return { ok: true, recognition: null }
  }
  let entityType: EntityType
  try {
    entityType = await resolveCompanyEntityType(supabase, companyId, (settings as { entity_type?: unknown } | null)?.entity_type)
  } catch (error) {
    return { ok: false, error }
  }

  const { data: itemData, error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, requested_amount, decided_amount')
    .eq('request_id', request.id)
  if (itemsError) return { ok: false, error: itemsError }
  const items = (itemData ?? []) as RequestItemRow[]
  if (items.length === 0) return { ok: true, recognition: null }
  const invoiceIds = [...new Set(items.map((item) => item.invoice_id))]

  const [invoicesRead, periodRead] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, invoice_number, currency, exchange_rate, vat_treatment, delivery_country, default_dimensions, journal_entry_id, subtotal, vat_amount, total, items:invoice_items(*)')
      .eq('company_id', companyId)
      .in('id', invoiceIds),
    supabase
      .from('fiscal_periods')
      .select('period_start')
      .eq('company_id', companyId)
      .lte('period_start', paymentDate)
      .gte('period_end', paymentDate)
      .order('period_start', { ascending: false })
      .limit(1),
  ])
  if (invoicesRead.error) return { ok: false, error: invoicesRead.error }
  if (periodRead.error) return { ok: false, error: periodRead.error }
  const periodStart = ((periodRead.data ?? []) as Array<{ period_start: string }>)[0]?.period_start
  // No räkenskapsår for the date: the voucher cannot post either.
  if (!periodStart) return { ok: true, recognition: null }

  const invoices = (invoicesRead.data ?? []) as InvoiceRow[]
  const evidence = await invoicesWithUnbookedShare(supabase, companyId, invoices, periodStart)
  if (!evidence.ok) return evidence
  const deferred = invoices.filter((invoice) => {
    if (!evidence.ids.has(invoice.id)) return false
    const items = [...(invoice.items ?? [])].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    invoice.items = items
    return splitDeductionShare(items, invoice.currency) !== null
  })
  if (deferred.length === 0) return { ok: true, recognition: null }

  const requestedTotal = roundOre(Number(request.requested_total))
  const paid = paidPerInvoice(items, requestedTotal, roundOre(paidAmount))
  if (!paid) {
    return {
      ok: false,
      code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN',
      details: { request_id: request.id, reason: 'per_invoice_amounts_unknown' },
    }
  }

  const lines: CreateJournalEntryLineInput[] = []
  const recognised: PayoutRecognition['invoices'] = []
  for (const invoice of deferred) {
    const amount = roundOre(paid.get(invoice.id) ?? 0)
    if (amount <= 0) continue
    const built = buildDeductionRecognitionLines(
      { ...invoice, items: invoice.items ?? undefined },
      entityType,
      amount,
    )
    // More paid than the invoice's deduction: the begäran and the invoice
    // disagree, and no rule says which share is which.
    if (!built || !equalOre(built.totalSek, amount)) {
      return {
        ok: false,
        code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN',
        details: { request_id: request.id, invoice_id: invoice.id, reason: 'paid_exceeds_deduction' },
      }
    }
    lines.push(...built.lines)
    recognised.push({ invoiceId: invoice.id, paid: amount })
  }
  if (recognised.length === 0) return { ok: true, recognition: null }
  return {
    ok: true,
    recognition: { amount: sumOre(recognised.map((inv) => inv.paid)), lines, invoices: recognised },
  }
}
