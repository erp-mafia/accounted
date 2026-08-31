import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getSuggestedCategories,
  buildMerchantHistory,
  merchantHistoryFor,
} from '@/lib/transactions/category-suggestions'
import {
  findCounterpartyTemplate,
  formatCounterpartyName,
} from '@/lib/bookkeeping/counterparty-templates'
import { getDefaultVatTreatmentForCategory } from '@/lib/bookkeeping/category-mapping'
import type { MappingRule, Transaction, VatTreatment } from '@/types'
import type { AccountCandidate } from './select-account'

/**
 * Tier 1 of the auto-booking cascade: deterministic candidate generation.
 *
 * Assembles the ranked slate of candidate accounts for one transaction from
 * the company's own memory: a learned counterparty template (the strongest
 * signal) plus mapping rules, keyword patterns and per-merchant history. This
 * is the same engine the `gnubok_suggest_categories` MCP tool uses; it runs
 * with NO model call. The slate is what the Tier-2 selector reasons over.
 *
 * Company-scoped throughout. Returns at most `limit` candidates, de-duplicated
 * by account (highest confidence wins), highest confidence first.
 */

const MAX_HISTORY_ROWS = 200

export async function gatherCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  limit = 8,
): Promise<AccountCandidate[]> {
  // The company's own rules plus the global (null-company) defaults. Two static
  // queries rather than one dynamic `.or('company_id.eq.<id>,...')`, which the
  // no-phantom-columns scanner can't resolve (and it would trip the ceiling).
  const [companyRulesRes, globalRulesRes, historyRes, cpMatch] = await Promise.all([
    supabase
      .from('mapping_rules')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('priority', { ascending: false }),
    supabase
      .from('mapping_rules')
      .select('*')
      .is('company_id', null)
      .eq('is_active', true)
      .order('priority', { ascending: false }),
    // Counterparty-keyed history: only the same merchant's past bookings, so
    // global frequency padding can't drown the signal in noise.
    supabase
      .from('transactions')
      .select('category, merchant_name, description, original_description')
      .eq('company_id', companyId)
      .not('is_business', 'is', null)
      .neq('category', 'uncategorized')
      .neq('category', 'private')
      .order('date', { ascending: false })
      .limit(MAX_HISTORY_ROWS),
    findCounterpartyTemplate(supabase, companyId, transaction),
  ])

  const mappingRules = [
    ...((companyRulesRes.data ?? []) as MappingRule[]),
    ...((globalRulesRes.data ?? []) as MappingRule[]),
  ]
  const merchantHistory = buildMerchantHistory(historyRes.data ?? [])

  const raw: AccountCandidate[] = []

  // 1. Learned counterparty template — the strongest signal (carries its own VAT).
  if (cpMatch?.template.debit_account) {
    const t = cpMatch.template
    raw.push({
      account: t.debit_account,
      label: formatCounterpartyName(t.counterparty_name),
      vatTreatment: (t.vat_treatment as VatTreatment | null) ?? null,
      source: 'counterparty_template',
      confidence: cpMatch.confidence,
      matchReason: `${t.occurrence_count ?? 0} tidigare bokföringar`,
    })
  }

  // 2. Rules / pattern / history suggestions. They don't carry VAT, so derive
  //    the category's default treatment (the selector can still flag reverse charge).
  const suggestions = getSuggestedCategories(
    transaction,
    mappingRules,
    merchantHistoryFor(
      merchantHistory,
      transaction.merchant_name,
      transaction.original_description ?? transaction.description,
    ),
  )
  for (const s of suggestions) {
    if (!s.account) continue
    raw.push({
      account: s.account,
      label: s.label,
      vatTreatment: getDefaultVatTreatmentForCategory(s.category),
      source: s.source,
      confidence: s.confidence,
      matchReason: s.match_reason,
    })
  }

  return dedupeByAccount(raw).slice(0, limit)
}

/** Keep one candidate per account (the highest-confidence one), highest confidence first. */
function dedupeByAccount(candidates: AccountCandidate[]): AccountCandidate[] {
  const best = new Map<string, AccountCandidate>()
  for (const c of candidates) {
    const existing = best.get(c.account)
    if (!existing || c.confidence > existing.confidence) best.set(c.account, c)
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}
