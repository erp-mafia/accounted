import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('complete-tax-deadline')

/**
 * Mark a system-generated tax deadline as completed from an external signal
 * (a declaration was generated, filed, or decided).
 *
 * Deadline completion is a courtesy on top of the filing flow, never part of
 * it: this helper logs failures and returns instead of throwing, so a broken
 * deadline row can never block a submission to Skatteverket.
 *
 * `taxPeriod` must use the deadline generator's format
 * (lib/tax/deadline-generator.ts): `YYYY-MM` for monthly, `YYYY-QN` for
 * quarterly, `YYYY` for annual. Build it from the caller's own period params;
 * do not reverse-parse Skatteverket's redovisningsperiod strings.
 *
 * Pass every deadline type that can represent the filing (e.g. both
 * `moms_monthly` and `moms_quarterly` for a VAT filing): the company's
 * settings decide which one exists, and the `IN` filter makes the wrong one
 * a no-op.
 */
export async function completeTaxDeadline(
  supabase: SupabaseClient,
  companyId: string,
  taxDeadlineTypes: string[],
  taxPeriod: string,
  newStatus: 'submitted' | 'confirmed'
): Promise<{ completed: number }> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('deadlines')
    .update({
      is_completed: true,
      completed_at: now,
      status: newStatus,
      status_changed_at: now,
    })
    .eq('company_id', companyId)
    .in('tax_deadline_type', taxDeadlineTypes)
    .eq('tax_period', taxPeriod)
    .eq('is_completed', false)
    .select('id')

  if (error) {
    log.warn('Failed to auto-complete tax deadline', {
      companyId,
      taxDeadlineTypes,
      taxPeriod,
      error: error.message,
    })
    return { completed: 0 }
  }

  return { completed: data?.length ?? 0 }
}
