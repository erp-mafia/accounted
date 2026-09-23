import type { SupabaseClient } from '@supabase/supabase-js'
import type { MappingResult } from '@/types'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

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
 * Return the subset of `accountNumbers` that the engine cannot resolve even
 * after its on-demand backfill (lib/bookkeeping/account-backfill.ts):
 *
 *  - numbers with no BAS 2026 reference (typos, non-standard accounts), and
 *  - accounts that exist in the chart but are deactivated (the backfill never
 *    resurrects a deliberate deactivation).
 *
 * An account that is simply absent from the chart but exists in BAS is NOT
 * returned: createDraftEntry seeds it automatically, so pre-validation in a
 * route must not 400 on it. Read-only on purpose: dry-run/preview paths use
 * the same check without side effects. Preserves first-seen order.
 */
export async function findUnresolvableAccounts(
  supabase: SupabaseClient,
  companyId: string,
  accountNumbers: readonly string[],
): Promise<string[]> {
  const missing = await findMissingActiveAccounts(supabase, companyId, accountNumbers)
  if (missing.length === 0) return []

  const basSeedable = missing.filter((num) => Boolean(getBASReference(num)))
  if (basSeedable.length === 0) return missing

  // A row that exists (but is inactive) blocks the backfill; a BAS number
  // with no row at all will be seeded by the engine.
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', basSeedable)

  if (error) throw error

  const existsInactive = new Set<string>((data ?? []).map((r) => r.account_number as string))
  return missing.filter((num) => !getBASReference(num) || existsInactive.has(num))
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
