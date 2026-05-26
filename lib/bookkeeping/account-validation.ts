import type { SupabaseClient } from '@supabase/supabase-js'
import type { MappingResult } from '@/types'

/**
 * Return the subset of `accountNumbers` that are NOT present-and-active in the
 * given company's chart_of_accounts. Mirrors the engine's resolveAccountIds
 * (lib/bookkeeping/engine.ts) so a pre-validation in API routes catches the
 * same condition (AccountsNotInChartError) before any DB writes happen.
 *
 * Empty/duplicate inputs are normalised; preserves first-seen order in output.
 * On Supabase error: bubbles up. A chart-of-accounts read failure is real
 * infrastructure trouble and should surface as 500 rather than be silently
 * masked as "account missing".
 */
export async function findMissingActiveAccounts(
  supabase: SupabaseClient,
  companyId: string,
  accountNumbers: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const num of accountNumbers) {
    if (!num) continue
    if (seen.has(num)) continue
    seen.add(num)
    unique.push(num)
  }
  if (unique.length === 0) return []

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('account_number', unique)

  if (error) throw error

  const present = new Set<string>((data ?? []).map((r) => r.account_number as string))
  return unique.filter((n) => !present.has(n))
}

/**
 * Extract every chart account number a MappingResult will post to: the headline
 * debit/credit plus every account_number in vat_lines. Returns the raw list
 * (duplicates intact); pass through findMissingActiveAccounts to dedupe.
 */
export function collectMappingResultAccounts(mr: MappingResult): string[] {
  const out: string[] = []
  if (mr.debit_account) out.push(mr.debit_account)
  if (mr.credit_account) out.push(mr.credit_account)
  for (const line of mr.vat_lines ?? []) {
    if (line.account_number) out.push(line.account_number)
  }
  return out
}
