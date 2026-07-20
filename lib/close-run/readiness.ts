import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import type {
  MonthEndCheck,
  MonthEndCheckKey,
  MonthEndReadinessReport,
} from './types'

const log = createLogger('close-run')

/**
 * Reconciliation tolerance in SEK: mirrors computeVatCloseCheck's blocker
 * threshold (öre-level drift and timing noise below this is a warning, not
 * a lock blocker).
 */
const RECON_BLOCKER_TOLERANCE_SEK = 100

/**
 * Gross-amount floor (SEK, incl. moms) above which a posted entry without
 * underlag is flagged. ML 17 kap 26-28 § (förenklad faktura) threshold;
 * mirrors computeVatCloseCheck's missing-receipts scan.
 */
const HIGH_VALUE_RECEIPT_THRESHOLD_SEK = 4000

/** Inclusive ISO date range for an ISO "YYYY-MM" month. */
export function monthRange(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Invalid month: ${month} (expected YYYY-MM)`)
  }
  const [year, m] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10)
  return { start: `${month}-01`, end: lastDay }
}

type CheckOutcome = Pick<MonthEndCheck, 'status' | 'count' | 'amount'>

async function runCheck(
  key: MonthEndCheckKey,
  companyId: string,
  fn: () => Promise<CheckOutcome>,
): Promise<MonthEndCheck> {
  try {
    return { key, ...(await fn()) }
  } catch (error) {
    // Fail CLOSED: an unverifiable check must block the lock, never pass.
    log.error(`month-end check failed: ${key}`, {
      companyId,
      reason: error instanceof Error ? error.message : String(error),
    })
    return { key, status: 'unknown', count: null }
  }
}

async function headCount(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number> {
  const { count, error } = await query
  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * Month-scoped readiness report: the honest "can this month be locked?"
 * checklist composed from the canonical per-check predicates. Blockers gate
 * the lock; warnings inform; 'unknown' (check errored) blocks, fail-closed.
 *
 * Predicate provenance (keep in sync with the owners):
 * - unbooked_transactions mirrors lib/worklist/categories.ts
 *   countUnbookedTransactions (is_business IS NULL AND is_ignored = false,
 *   the canonical "att bokföra" predicate: NOT bare journal_entry_id IS NULL,
 *   which multi-allocation booking keeps NULL) and period-service
 *   lockPeriod's hard gate, date-bounded to the month.
 * - bank/receipts thresholds mirror the mcp-server computeVatCloseCheck
 *   (core cannot import extensions, so the constants live here too).
 */
export async function buildMonthEndReadinessReport(
  supabase: SupabaseClient,
  companyId: string,
  month: string,
): Promise<MonthEndReadinessReport> {
  const { start, end } = monthRange(month)

  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const lockedThrough = (settings?.bookkeeping_locked_through as string | null) ?? null

  const checks = await Promise.all([
    runCheck('unbooked_transactions', companyId, async () => {
      const count = await headCount(
        supabase
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .gte('date', start)
          .lte('date', end)
          .is('is_business', null)
          .eq('is_ignored', false),
      )
      return { status: count > 0 ? 'blocker' : 'pass', count }
    }),

    runCheck('unattested_supplier_invoices', companyId, async () => {
      const count = await headCount(
        supabase
          .from('supplier_invoices')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'registered')
          .gte('invoice_date', start)
          .lte('invoice_date', end),
      )
      return { status: count > 0 ? 'blocker' : 'pass', count }
    }),

    runCheck('bank_unreconciled', companyId, async () => {
      const recon = await getReconciliationStatus(supabase, companyId, start, end)
      const difference = Math.round(recon.difference * 100) / 100
      if (recon.is_reconciled) {
        return { status: 'pass', count: 0, amount: difference }
      }
      return {
        status: Math.abs(difference) > RECON_BLOCKER_TOLERANCE_SEK ? 'blocker' : 'warning',
        count: recon.unmatched_transaction_count,
        amount: difference,
      }
    }),

    runCheck('draft_entries', companyId, async () => {
      const count = await headCount(
        supabase
          .from('journal_entries')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'draft')
          .gte('entry_date', start)
          .lte('entry_date', end),
      )
      return { status: count > 0 ? 'blocker' : 'pass', count }
    }),

    runCheck('missing_receipts_high_value', companyId, async () => {
      const { data, error } = await supabase
        .from('journal_entries')
        .select('id, document_attachments(id), journal_entry_lines(debit_amount)')
        .eq('company_id', companyId)
        .in('source_type', ['bank_transaction', 'supplier_invoice', 'receipt'])
        .eq('status', 'posted')
        .gte('entry_date', start)
        .lte('entry_date', end)
      if (error) throw new Error(error.message)
      const count = (data ?? []).filter((entry) => {
        const lines = (entry.journal_entry_lines ?? []) as { debit_amount: number | string }[]
        const gross = lines.reduce((sum, line) => sum + (Number(line.debit_amount) || 0), 0)
        const docs = entry.document_attachments as unknown[] | null
        return gross >= HIGH_VALUE_RECEIPT_THRESHOLD_SEK && (!docs || docs.length === 0)
      }).length
      // Warning, not blocker: BFL requires the underlag but a missing scan
      // should not make the month unlockable; it surfaces loudly instead.
      return { status: count > 0 ? 'warning' : 'pass', count }
    }),
  ])

  return {
    companyId,
    month,
    start,
    end,
    lockedThrough,
    alreadyLocked: lockedThrough !== null && end <= lockedThrough,
    checks,
    ready: checks.every((c) => c.status === 'pass' || c.status === 'warning'),
  }
}
