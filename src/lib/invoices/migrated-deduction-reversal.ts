/**
 * Business-state mirror of a reversed rot_rut_reclassification voucher.
 *
 * The post-migration deduction step (lib/invoices/migrated-deduction-apply.ts)
 * moves a migrated invoice's household deduction from 1510 to 1513 and
 * writes the deduction onto the invoice. When that voucher is reversed, the
 * storno puts the deduction back on 1510, so the invoice must read it as the
 * buyer's again: no deduction, the full open amount, and a status derived
 * from what was paid (revert_migrated_invoice_deduction).
 *
 * Two calls from reverseEntry(), kept in this module so the engine can import
 * it without a cycle (the apply service imports the entries builder, which
 * imports the engine):
 *   - assertMigratedDeductionReversible runs BEFORE the storno is booked. A
 *     begäran made here that holds the invoice (or a reclaim that followed
 *     one) refuses the reversal: the begäran asks Skatteverket for exactly
 *     this 1513 claim, and a storno would leave the ledger and the begäran
 *     disagreeing. Cancel the begäran first.
 *   - syncMigratedDeductionAfterReversal runs after the storno is posted and
 *     reverts the invoice. It asks the same question again under the row
 *     lock; a failure is logged loudly and is retryable by support through
 *     the same idempotent RPC (the storno stands either way).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { MigratedDeductionHeldByRequestError } from '@/lib/bookkeeping/errors'

const log = createLogger('invoices/migrated-deduction-reversal')

interface RevertResult {
  ok: boolean
  code?: string
  reverted?: boolean
  status?: string
}

export async function assertMigratedDeductionReversible(
  supabase: SupabaseClient,
  companyId: string,
  entry: { id: string; source_id: string | null },
): Promise<void> {
  if (!entry.source_id) return
  const { data, error } = await supabase.rpc('revert_migrated_invoice_deduction', {
    p_company_id: companyId,
    p_invoice_id: entry.source_id,
    p_journal_entry_id: entry.id,
    p_check_only: true,
  })
  // Unverifiable is not reversible: the storno can be retried, an
  // inconsistent begäran cannot be taken back.
  if (error) throw error
  const result = (data ?? {}) as RevertResult
  if (!result.ok && result.code === 'HELD_BY_REQUEST') {
    throw new MigratedDeductionHeldByRequestError(entry.source_id)
  }
  if (!result.ok) {
    log.warn('reclassification reversal check refused; reversing anyway', {
      entryId: entry.id,
      invoiceId: entry.source_id,
      code: result.code,
    })
  }
}

export async function syncMigratedDeductionAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  entry: { id: string; source_id: string | null },
): Promise<void> {
  if (!entry.source_id) return
  const { data, error } = await supabase.rpc('revert_migrated_invoice_deduction', {
    p_company_id: companyId,
    p_invoice_id: entry.source_id,
    p_journal_entry_id: entry.id,
    p_check_only: false,
  })
  const result = (data ?? {}) as RevertResult
  if (error || !result.ok) {
    log.error('reclassification reversed but the invoice still carries its deduction (re-run the revert RPC)', error as Error | undefined, {
      entryId: entry.id,
      invoiceId: entry.source_id,
      code: result.code,
    })
    return
  }
  if (result.reverted) {
    log.info('migrated deduction reverted after storno', {
      entryId: entry.id,
      invoiceId: entry.source_id,
      status: result.status,
    })
  }
}
