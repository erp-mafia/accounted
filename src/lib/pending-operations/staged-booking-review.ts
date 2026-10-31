/**
 * Hard blocks on staged operations (accounted#130 step 2, #145): what the
 * approval doors (commitPendingOperation) and the grant door
 * (lib/grants/enforce.ts) ask before an operation is claimed. A staged
 * booking of a bank row is judged by lib/booking-review/operation-gate.ts; a
 * staged supplier invoice from the Inkorg (create_supplier_invoice_from_inbox)
 * here, where both the booking-review rules and the supplier-invoice rules
 * may be read. Null when nothing it books is matched.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PendingOperation } from '@/types'
import { createLogger } from '@/lib/logger'
import { factsFromLines, grantCounterpartyKey, matchBookingReviewRules } from '@/lib/booking-review/match'
import { loadActiveBookingReviewRules } from '@/lib/booking-review/rules'
import { operationBookingReview, type OperationBookingReview } from '@/lib/booking-review/operation-gate'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { foldSellerVatIntoCost, sellerVatIsCost } from '@/lib/bookkeeping/vat-registration'
import {
  supplierInvoiceRegistrationLines,
  type SupplierInvoiceBookingItem,
  type SupplierInvoiceRegistrationHeader,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { resolveSupplierInvoiceReverseCharge } from '@/lib/supplier-invoices/create'

const log = createLogger('pending-operations/staged-booking-review')

type StagedOp = Pick<PendingOperation, 'operation_type' | 'params' | 'preview_data'>

/** The rules a staged operation's booking matches, and the amount a booking_review limit is judged on. */
export async function stagedBookingReview(
  supabase: SupabaseClient,
  companyId: string,
  op: StagedOp,
): Promise<OperationBookingReview | null> {
  if (op.operation_type === 'create_supplier_invoice_from_inbox') return supplierInvoiceReview(supabase, companyId, op)
  return operationBookingReview(supabase, companyId, op)
}

type StagedItem = Partial<Record<keyof SupplierInvoiceBookingItem | 'unit_price', unknown>>

/**
 * A staged supplier invoice from the Inkorg, judged on the verifikat its
 * registration books (supplierInvoiceRegistrationLines, the builder the
 * executor posts through and the review dialog previews, over the items as
 * the executor stores them: its reverse-charge rule and, for a company that
 * is not VAT-registered, the seller's moms folded into the cost) and on its
 * supplier with the invoice total in SEK. Null when it books nothing now (an
 * already-booked invoice registered against its verifikat; kontantmetoden or
 * deferred booking, whose preview says will_post_journal_entry false) or no
 * rule matches. Lines that cannot be built (no exchange rate) count as a
 * match while the company has rules: the operation waits for a person.
 * commit_journal_entry judges the posted lines again.
 */
async function supplierInvoiceReview(
  supabase: SupabaseClient,
  companyId: string,
  op: Pick<PendingOperation, 'params' | 'preview_data'>,
): Promise<OperationBookingReview | null> {
  const params = (op.params ?? {}) as Record<string, unknown>
  if (isRegisterBookedInvoiceParams(params)) return null
  if ((op.preview_data as { will_post_journal_entry?: unknown } | null)?.will_post_journal_entry === false) return null
  if (typeof params.supplier_id !== 'string') return null
  const rules = await loadActiveBookingReviewRules(supabase, companyId)
  if (rules.length === 0) return null
  const [{ data: supplierRow }, { data: settingsRow }] = await Promise.all([
    supabase.from('suppliers').select('name, supplier_type').eq('id', params.supplier_id).eq('company_id', companyId).maybeSingle(),
    supabase.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle(),
  ])
  const supplier = supplierRow as { name: string | null; supplier_type: string | null } | null
  const staged = typeof params.vat_treatment === 'string' && params.vat_treatment ? params.vat_treatment : undefined
  const { reverseCharge, vatTreatment } = resolveSupplierInvoiceReverseCharge(
    supplier?.supplier_type ?? null,
    staged ? { reverse_charge: staged === 'reverse_charge', vat_treatment: staged } : {},
  )
  const total = Number(params.total) || 0
  const exchangeRate = typeof params.exchange_rate === 'number' ? params.exchange_rate : null
  const amountSek = Math.abs(total) * (exchangeRate ?? 1)
  const header = {
    currency: typeof params.currency === 'string' ? params.currency : 'SEK',
    exchange_rate: exchangeRate,
    reverse_charge: reverseCharge,
    reverse_charge_kind: params.reverse_charge_kind ?? null,
    vat_treatment: vatTreatment,
    default_dimensions: params.default_dimensions ?? null,
    total,
  } as SupplierInvoiceRegistrationHeader
  const rows = (Array.isArray(params.items) ? (params.items as StagedItem[]) : []).map((item) => {
    const lineTotal = Number(item.line_total) || 0
    return {
      account_number: item.account_number,
      line_total: lineTotal,
      unit_price: Number(item.unit_price) || lineTotal,
      vat_rate: reverseCharge ? 0 : Number(item.vat_rate) || 0,
      vat_amount: reverseCharge ? 0 : Number(item.vat_amount) || 0,
      reverse_charge_rate: reverseCharge ? (item.reverse_charge_rate ?? null) : null,
      accrual_period_start: item.accrual_period_start ?? null,
      accrual_period_end: item.accrual_period_end ?? null,
      accrual_balance_account: item.accrual_balance_account ?? null,
      dimensions: item.dimensions,
      apply_slp: item.apply_slp === true,
    }
  })
  const vatRegistered = (settingsRow as { vat_registered?: boolean | null } | null)?.vat_registered
  const items = (sellerVatIsCost(vatRegistered, reverseCharge) ? foldSellerVatIntoCost(rows).lines : rows) as unknown as SupplierInvoiceBookingItem[]
  let lines: ReturnType<typeof supplierInvoiceRegistrationLines>
  try {
    const chart = reverseCharge ? await fetchChartVatTreatments(supabase, companyId) : undefined
    lines = supplierInvoiceRegistrationLines(header, items, supplier?.supplier_type ?? null, '', chart)
  } catch (error) {
    // No rate or no momskoder: what it would book is not known, so it waits for a person.
    log.warn('a staged supplier invoice could not be judged before approval; it waits for a person', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { matched: [], amountSek }
  }
  const matched = matchBookingReviewRules(
    rules,
    factsFromLines(lines, [{ counterpartyKey: grantCounterpartyKey(supplier?.name, null, null), amountSek }]),
  )
  return matched.length > 0 ? { matched, amountSek } : null
}

