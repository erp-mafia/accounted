/**
 * Bridges invoice flows to accrual schedules: after the registration/revenue
 * entry is committed, every line that carries a periodisering period gets a
 * schedule (+ synchronous catch-up posting for months that already began).
 *
 * Idempotent per line: lines already covered by a schedule are skipped, so
 * event replays (supplier_invoice.confirmed) can never double-schedule.
 * Failures are logged and counted, never thrown: the origin entry is already
 * committed and must not be rolled back by a schedule hiccup; the caller
 * surfaces a warning instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { createAccrualSchedule } from '@/lib/bookkeeping/accruals/service'
import {
  itemHasAccrual,
  suggestBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import type { EntityType } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.accruals.from-invoices')

export interface ScheduleCreationResult {
  created: number
  failed: number
}

export async function createSchedulesForSupplierInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  originJournalEntryId: string,
): Promise<ScheduleCreationResult> {
  const accrualItems = items.filter(itemHasAccrual)
  const result: ScheduleCreationResult = { created: 0, failed: 0 }
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

  for (const item of accrualItems) {
    if (item.id && covered.has(item.id)) continue
    try {
      const totalSek =
        Math.round(
          resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate) *
            100,
        ) / 100
      await createAccrualSchedule(
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
          description: `${item.description} (leverantörsfaktura ${invoice.supplier_invoice_number})`,
        },
        {
          originJournalEntryId,
          // The registration entry is dated invoice_date: dissolutions may
          // never precede it.
          postingFloorDate: invoice.invoice_date,
        },
      )
      result.created++
    } catch (error) {
      result.failed++
      log.error('failed to create accrual schedule for supplier invoice line', error, {
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
  const result: ScheduleCreationResult = { created: 0, failed: 0 }
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

  for (const item of accrualItems) {
    if (item.id && covered.has(item.id)) continue
    const target = resolveRevenueTarget(item, invoice.vat_treatment, entityType)
    // reverse_charge/export lines keep their statutory account (3308/3305) so
    // ruta 39/40 in the momsdeklaration stay correct: never deferred. The
    // generator applies the same exclusion, so the net stays on 3308/3305.
    if (target.special) continue
    try {
      const targetAccount = target.account
      const totalSek =
        Math.round(
          resolveSekAmount(item.line_total, null, invoice.currency, invoice.exchange_rate) *
            100,
        ) / 100
      await createAccrualSchedule(
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
          description: `${item.description} (faktura ${invoice.invoice_number ?? ''})`.trim(),
        },
        {
          originJournalEntryId,
          postingFloorDate: invoice.invoice_date,
        },
      )
      result.created++
    } catch (error) {
      result.failed++
      log.error('failed to create accrual schedule for invoice line', error, {
        companyId,
        entityId: invoice.id,
      })
    }
  }

  return result
}

/**
 * Resolve a line's revenue account exactly the way generatePerRateLines does:
 * per-line override only for ordinary domestic rates; reverse_charge/export
 * force the statutory account and are flagged `special` (never deferrable).
 */
function resolveRevenueTarget(
  item: InvoiceItem,
  invoiceTreatment: Invoice['vat_treatment'],
  entityType: EntityType,
): { account: string; special: boolean } {
  const rate = item.vat_rate ?? 0
  const treatment =
    rate === 0 && (invoiceTreatment === 'reverse_charge' || invoiceTreatment === 'export')
      ? invoiceTreatment
      : getVatTreatmentForRate(rate)
  const special = treatment === 'reverse_charge' || treatment === 'export'
  const account =
    !special && item.revenue_account
      ? item.revenue_account
      : getRevenueAccount(treatment, entityType)
  return { account, special }
}
