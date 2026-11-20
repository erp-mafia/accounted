/**
 * Bridges invoice flows to accrual schedules: after the registration/revenue
 * entry is committed, every line that carries a periodisering period gets a
 * schedule (+ synchronous catch-up posting for months that already began).
 *
 * Idempotent per line: lines already covered by a schedule are skipped, so
 * a retried call can never double-schedule.
 * Failures are logged and counted, never thrown: the origin entry is already
 * committed and must not be rolled back by a schedule hiccup; the caller
 * surfaces a warning instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { supplierInvoiceReference } from '@/lib/bookkeeping/supplier-invoice-description'
import { createAccrualSchedule, postDueInstallments } from '@/lib/bookkeeping/accruals/service'
import {
  coerceDimensionsBag,
  mergeDimensionBags,
} from '@/lib/bookkeeping/dimension-resolver'
import {
  itemHasAccrual,
  suggestBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import { isZeroRatedInvoiceTreatment, resolveLineVatTreatment } from '@/lib/bookkeeping/invoice-line-vat-treatment'
import { toSingleLine } from '@/lib/utils'
import type { EntityType } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.accruals.from-invoices')

export interface ScheduleCreationResult {
  created: number
  failed: number
  /**
   * Months that were due at creation but could not be posted (they stay
   * pending with last_error, retried by the cron and Bokför förfallna). For
   * an upplupen kostnad or intäkt every month is due at once, so a failure
   * leaves the interim account (29xx debited, 17xx credited) without its
   * cost or revenue until the retry succeeds.
   */
  releasesFailed?: number
}

/**
 * The warning a door returns when a periodisering month could not be posted
 * right after the registration (ScheduleCreationResult.releasesFailed).
 */
export const ACCRUAL_RELEASE_FAILED_WARNING = {
  code: 'ACCRUAL_RELEASE_FAILED',
  message_sv:
    'Fakturan bokfördes, men en eller flera periodiseringsmånader kunde inte bokföras. ' +
    'De står kvar som väntande med orsaken under Bokföring → Periodiseringar: åtgärda den och välj Bokför förfallna.',
  message_en:
    'The invoice was booked, but one or more accrual months (periodiseringar) could not be posted. ' +
    'They stay pending with the reason under Bokföring > Periodiseringar: fix it and choose Bokför förfallna.',
} as const

export async function createSchedulesForSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  originJournalEntryId: string,
): Promise<ScheduleCreationResult> {
  const accrualItems = items.filter(itemHasAccrual)
  const result: ScheduleCreationResult = { created: 0, failed: 0, releasesFailed: 0 }
  if (accrualItems.length === 0) return result

  const { data: existing } = await supabase
    .from('accrual_schedules')
    .select('supplier_invoice_item_id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoice.id)
  const covered = new Set(
    ((existing ?? []) as Array<{ supplier_invoice_item_id: string | null }>).map(
      (row) => row.supplier_invoice_item_id,
    ),
  )

  // Same merge the registration entry used for the item's interim 17xx line
  // (groupExpenseBuckets): the schedule's bag must match the origin so the
  // dissolutions keep the per-dimension interim balance at zero.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  for (const item of accrualItems) {
    if (item.id && covered.has(item.id)) continue
    let scheduleId: string
    try {
      const totalSek =
        Math.round(
          resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate) *
            100,
        ) / 100
      const schedule = await createAccrualSchedule(
        supabase,
        companyId,
        userId,
        {
          direction: 'expense',
          supplierInvoiceId: invoice.id,
          supplierInvoiceItemId: item.id ?? null,
          balanceAccount:
            item.accrual_balance_account ??
            suggestBalanceAccount('expense', item.account_number),
          targetAccount: item.account_number,
          totalAmountSek: totalSek,
          periodStart: item.accrual_period_start as string,
          periodEnd: item.accrual_period_end as string,
          description: `${toSingleLine(item.description)} (leverantörsfaktura ${supplierInvoiceReference(invoice.supplier_invoice_number, invoice.arrival_number)})`,
          dimensions: mergeDimensionBags(defaultDimensions, item.dimensions),
        },
        {
          originJournalEntryId,
          // The registration entry is dated invoice_date: a förutbetald
          // kostnad (17xx) may never dissolve before it. An upplupen kostnad
          // (29xx) books on its own month-ends, before it.
          postingFloorDate: invoice.invoice_date,
          // Catch-up runs below, so its failures reach the caller.
          postCatchUp: false,
        },
      )
      scheduleId = schedule.id
      result.created++
    } catch (error) {
      result.failed++
      log.error('failed to create accrual schedule for supplier invoice line', error, {
        companyId,
        entityId: invoice.id,
      })
      continue
    }

    // Post every month that has already begun (an upplupen kostnad: all of
    // them). A month that fails stays pending with last_error for the cron
    // and Bokför förfallna; the count goes back so the door can say so now.
    try {
      const catchUp = await postDueInstallments(supabase, companyId, { userId, scheduleId })
      result.releasesFailed = (result.releasesFailed ?? 0) + catchUp.failed
    } catch (error) {
      result.releasesFailed = (result.releasesFailed ?? 0) + 1
      log.error('accrual catch-up posting failed for supplier invoice line', error, {
        companyId,
        entityId: invoice.id,
      })
    }
  }

  return result
}

export async function createSchedulesForCustomerInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  items: InvoiceItem[],
  originJournalEntryId: string,
  entityType: EntityType = 'enskild_firma',
): Promise<ScheduleCreationResult> {
  const accrualItems = items.filter(
    (item) => itemHasAccrual(item) && item.line_type !== 'text' && !item.deduction_type,
  )
  const result: ScheduleCreationResult = { created: 0, failed: 0, releasesFailed: 0 }
  if (accrualItems.length === 0) return result

  const { data: existing } = await supabase
    .from('accrual_schedules')
    .select('invoice_item_id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoice.id)
  const covered = new Set(
    ((existing ?? []) as Array<{ invoice_item_id: string | null }>).map(
      (row) => row.invoice_item_id,
    ),
  )

  // Same merge the revenue entry used for the item's interim 29xx/17xx line
  // (generatePerRateLines): item bag wins per key over the invoice default.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  for (const item of accrualItems) {
    if (item.id && covered.has(item.id)) continue
    const target = resolveRevenueTarget(item, invoice.vat_treatment, entityType)
    // reverse_charge/export lines keep their statutory account (3308/3305) so
    // ruta 39/40 in the momsdeklaration stay correct: never deferred. The
    // generator applies the same exclusion, so the net stays on 3308/3305.
    if (target.special) continue
    let scheduleId: string
    try {
      const targetAccount = target.account
      const totalSek =
        Math.round(
          resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate) *
            100,
        ) / 100
      const schedule = await createAccrualSchedule(
        supabase,
        companyId,
        userId,
        {
          direction: 'revenue',
          invoiceId: invoice.id,
          invoiceItemId: item.id ?? null,
          balanceAccount:
            item.accrual_balance_account ?? suggestBalanceAccount('revenue', targetAccount),
          targetAccount,
          totalAmountSek: totalSek,
          periodStart: item.accrual_period_start as string,
          periodEnd: item.accrual_period_end as string,
          // Voucher text is one line by format (SIE #VER is one record per
          // line); the line description may carry line breaks.
          description: `${toSingleLine(item.description)} (faktura ${invoice.invoice_number ?? ''})`.trim(),
          dimensions: mergeDimensionBags(defaultDimensions, item.dimensions),
        },
        {
          originJournalEntryId,
          // The revenue entry is dated invoice_date: a förutbetald intäkt
          // (29xx) may never dissolve before it. An upplupen intäkt (17xx)
          // books on its own month-ends, before it.
          postingFloorDate: invoice.invoice_date,
          // Catch-up runs below, so its failures reach the caller.
          postCatchUp: false,
        },
      )
      scheduleId = schedule.id
      result.created++
    } catch (error) {
      result.failed++
      log.error('failed to create accrual schedule for invoice line', error, {
        companyId,
        entityId: invoice.id,
      })
      continue
    }

    // Post every month that has already begun (an upplupen intäkt: all of
    // them). A month that fails stays pending with last_error for the cron
    // and Bokför förfallna; the count goes back so the door can say so now.
    try {
      const catchUp = await postDueInstallments(supabase, companyId, { userId, scheduleId })
      result.releasesFailed = (result.releasesFailed ?? 0) + catchUp.failed
    } catch (error) {
      result.releasesFailed = (result.releasesFailed ?? 0) + 1
      log.error('accrual catch-up posting failed for invoice line', error, {
        companyId,
        entityId: invoice.id,
      })
    }
  }

  return result
}

/**
 * Resolve a line's revenue account exactly the way generatePerRateLines does:
 * per-line override only for ordinary domestic rates; reverse charge (EU or
 * domestic) and export force the statutory account and are flagged `special`
 * (never deferrable).
 */
function resolveRevenueTarget(
  item: InvoiceItem,
  invoiceTreatment: Invoice['vat_treatment'],
  entityType: EntityType,
): { account: string; special: boolean } {
  const rate = item.vat_rate ?? 0
  const treatment = resolveLineVatTreatment(rate, invoiceTreatment)
  const special = isZeroRatedInvoiceTreatment(treatment)
  const account =
    !special && item.revenue_account
      ? item.revenue_account
      : getRevenueAccount(treatment, entityType)
  return { account, special }
}
