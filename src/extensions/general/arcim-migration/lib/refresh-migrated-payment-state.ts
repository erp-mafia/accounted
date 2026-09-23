/**
 * Refresh the payment state of migrated supplier invoices from the provider.
 *
 * A migration can only write what its mapper read. The Bokio supplier-invoice
 * mapper read `status` and `paidAmount`, neither of which exists on Bokio's
 * `supplierInvoiceGet` schema, so every imported invoice landed as
 * "Registrerad" with its whole total outstanding: 365 invoices for the company
 * that reported it on 2026-09-14, 417 for a second Bokio company. The mapper
 * now reads `remainingAmount`, the payment field Bokio does publish, but the
 * rows already written stay wrong until something asks the provider again.
 *
 * That is what this pass does. It does NOT guess: a one-shot UPDATE marking
 * the 365 rows paid would fabricate payments, and some of them are genuinely
 * open. Bokio knows which, so Bokio is asked, and the answer is read by the
 * same rule the import uses (resolveSupplierSettlement), so the repair cannot
 * contradict the import it repairs.
 *
 * Guarantees:
 * - Only `status`, `paid_amount`, `remaining_amount` and `paid_at` are
 *   written, on rows of this company only. Nothing is inserted or deleted.
 * - Candidates exclude anything already booked or paid in Accounted
 *   (registration or payment voucher present, or paid_amount > 0) and every
 *   credit note, so a repair can never touch a row a verifikat depends on.
 * - The join is strict: invoice number AND invoice date, only when that pair
 *   is unique on both sides. Two suppliers can legitimately issue "1001" in
 *   the same year, and a wrong join would settle the wrong payable.
 * - An invoice still open at the provider is left exactly as it is.
 *
 * The list endpoint is enough (Bokio's list payload carries remainingAmount),
 * so this deliberately uses fetchSupplierInvoicesDirect rather than the
 * hydrated fetch: detail hydration would spend the whole time budget
 * re-fetching a schema that adds nothing here.
 */

import { queryInExecutionBudget } from '@/lib/http/execution-budget'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { ProviderName } from '@/lib/providers/types'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchSupplierInvoicesDirect } from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSupplierSettlement } from './entity-mapper'
import { joinKey, uniqueByKey } from './relink-registration-vouchers'
import type { BokioSupplierSnapshot } from './complete-bokio-supplier-invoices'

const log = createLogger('extensions/arcim-migration/refresh-payment-state')

/**
 * Statuses a repair may move. 'paid', 'partially_paid', 'credited' and
 * 'reversed' are outcomes something already decided here; only an invoice
 * still standing as an open payable is refreshed.
 */
const OPEN_STATUSES = ['registered', 'approved', 'overdue'] as const

export interface RefreshMigratedSupplierPaymentStateOptions {
  supabase: SupabaseClient
  companyId: string
  consentId: string
  dryRun?: boolean
  /** Payment vouchers already linked (or planned in a dry run) by reconciliation. */
  excludeInvoiceIds?: string[]
  snapshot?: BokioSupplierSnapshot
  eligibleInvoiceIds?: ReadonlySet<string>
}

export interface RefreshMigratedSupplierPaymentStateResult {
  /** Supplier invoices the provider returned. */
  providerInvoices: number
  /** Provider invoices that joined to an open, untouched invoice here. */
  matched: number
  /** Matched invoices the provider reports as settled, and that were written. */
  updated: number
  /** Matched invoices the provider still reports as open: left alone. */
  unchanged: number
  /** Provider invoices with no open counterpart here, or an ambiguous join. */
  unmatched: number
  dryRun: boolean
}

interface OpenSupplierRow {
  id: string
  supplier_invoice_number: string | null
  invoice_date: string
  total: number | null
}

export async function refreshMigratedSupplierPaymentState(
  options: RefreshMigratedSupplierPaymentStateOptions,
): Promise<RefreshMigratedSupplierPaymentStateResult> {
  const { supabase, companyId, consentId, dryRun = false } = options

  const resolved = options.snapshot?.connection ?? await resolveConsent(companyId, consentId)
  const provider = resolved.consent.provider as ProviderName

  const providerInvoices = options.snapshot?.invoices ?? await fetchSupplierInvoicesDirect(
    provider,
    resolved.accessToken,
    resolved.providerCompanyId,
  )

  const openRows = await fetchAllRows<OpenSupplierRow>(({ from, to }) =>
    queryInExecutionBudget(supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, invoice_date, total')
      .eq('company_id', companyId)
      .is('registration_journal_entry_id', null)
      .is('payment_journal_entry_id', null)
      .eq('paid_amount', 0)
      .eq('is_credit_note', false)
      .in('status', [...OPEN_STATUSES])
      .order('id', { ascending: true })
      .range(from, to)),
  )

  const excluded = new Set(options.excludeInvoiceIds)
  const openByKey = uniqueByKey(openRows.filter(row => !excluded.has(row.id)
    && (!options.eligibleInvoiceIds || options.eligibleInvoiceIds.has(row.id))),
    (row) => joinKey(row.supplier_invoice_number, row.invoice_date))
  const providerByKey = uniqueByKey(providerInvoices, (dto) => joinKey(dto.invoiceNumber, dto.issueDate))

  let matched = 0
  let updated = 0
  let unchanged = 0

  for (const [key, dto] of providerByKey) {
    const row = openByKey.get(key)
    if (!row) continue
    matched++

    // The row's own total is what its paid_amount / remaining_amount are
    // denominated in, so the settlement is computed against it; a row with no
    // amount has nothing to settle.
    const total = typeof row.total === 'number' ? row.total : Number.NaN
    if (!Number.isFinite(total) || total <= 0) {
      unchanged++
      continue
    }

    const settlement = resolveSupplierSettlement(dto.paymentStatus, total)
    if (settlement.status !== 'paid' && settlement.status !== 'partially_paid') {
      unchanged++
      continue
    }

    if (!dryRun) {
      const { data, error } = await queryInExecutionBudget(supabase
        .from('supplier_invoices')
        .update({
          status: settlement.status,
          paid_amount: settlement.paidAmount,
          remaining_amount: settlement.remainingAmount,
          paid_at: settlement.paidAt,
        })
        .eq('id', row.id)
        .eq('company_id', companyId)
        // Recheck eligibility and identity: a user may have booked, paid or
        // edited the invoice while the provider was being read.
        .is('registration_journal_entry_id', null)
        .is('payment_journal_entry_id', null)
        .eq('paid_amount', 0)
        .eq('is_credit_note', false)
        .in('status', [...OPEN_STATUSES])
        .eq('total', total)
        .eq('supplier_invoice_number', row.supplier_invoice_number)
        .eq('invoice_date', row.invoice_date)
        .select('id')
        .maybeSingle())

      if (error) {
        log.error('supplier invoice payment-state update failed', new Error(error.message), {
          companyId,
          invoiceId: row.id,
        })
        // Reconciliation must leave registration unlinked after a failed
        // refresh, otherwise its next attempt excludes the failed rows.
        throw new Error(error.message)
      }
      if (!data) {
        unchanged++
        continue
      }
    }
    updated++
  }

  const result: RefreshMigratedSupplierPaymentStateResult = {
    providerInvoices: providerInvoices.length,
    matched,
    updated,
    unchanged,
    unmatched: providerInvoices.length - matched,
    dryRun,
  }

  log.info('refreshed migrated supplier payment state', { companyId, provider, ...result })

  return result
}
