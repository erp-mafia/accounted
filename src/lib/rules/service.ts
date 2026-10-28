import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { aliasPatterns, postgrestFilterValue, type RuleMode, type RuleRow } from './model'

/**
 * Regler data access (UI v2 PR 5). The rows are categorization_templates;
 * this keeps the column list and the match query in one place so the list
 * route, the detail route and the MCP surface read the same thing.
 */

export interface RuleMatch {
  id: string
  date: string
  description: string
  amount: number
  currency: string
  journal_entry_id: string | null
}

/** Postgres: the column does not exist (the ladder migration has not run here yet). */
const UNDEFINED_COLUMN = '42703'

/**
 * Before migration 20260907120000 the table has is_active but no mode,
 * corrections or paused_at. Read the same rows through the old columns so
 * the page works on a database the migration has not reached: active means
 * propose, inactive means paused, nothing has been corrected yet.
 */
function fromLegacyRow(row: Record<string, unknown>): RuleRow {
  const { is_active, ...rest } = row
  return {
    ...rest,
    mode: is_active === false ? 'paused' : 'propose',
    corrections: 0,
    paused_at: null,
  } as unknown as RuleRow
}

/**
 * Every rule of the company, paged: one company holds more than PostgREST's
 * 1,000-row page, and the list ended at an arbitrary 1,000. id breaks the
 * occurrence_count/updated_at ties so the pages never overlap or skip.
 */
export async function listRules(supabase: SupabaseClient, companyId: string): Promise<RuleRow[]> {
  try {
    return await fetchAllRows<RuleRow>(({ from, to }) =>
      supabase
        .from('categorization_templates')
        .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, created_at, updated_at')
        .eq('company_id', companyId)
        .order('occurrence_count', { ascending: false })
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to),
    )
  } catch (error) {
    if ((error as { code?: string }).code !== UNDEFINED_COLUMN) throw error
    const legacy = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('categorization_templates')
        .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, confidence, last_seen_date, source, is_active, created_at, updated_at')
        .eq('company_id', companyId)
        .order('occurrence_count', { ascending: false })
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to),
    )
    return legacy.map(fromLegacyRow)
  }
}

export async function getRule(supabase: SupabaseClient, companyId: string, id: string): Promise<RuleRow | null> {
  const { data, error } = await supabase
    .from('categorization_templates')
    .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error && error.code === UNDEFINED_COLUMN) {
    const legacy = await supabase
      .from('categorization_templates')
      .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, confidence, last_seen_date, source, is_active, created_at, updated_at')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()
    if (legacy.error) throw legacy.error
    return legacy.data ? fromLegacyRow(legacy.data as Record<string, unknown>) : null
  }
  if (error) throw error
  return (data as unknown as RuleRow) ?? null
}

/**
 * Booked transactions this year whose bank text matches the rule's
 * counterparty or one of its aliases. An approximation of "träffar i år":
 * bookings do not carry the template id, so the description is the link.
 */
export async function listRuleMatches(
  supabase: SupabaseClient,
  companyId: string,
  rule: RuleRow,
  now = new Date(),
  limit = 20,
): Promise<RuleMatch[]> {
  const patterns = aliasPatterns(rule)
  if (patterns.length === 0) return []
  const yearStart = `${now.getFullYear()}-01-01`
  const orFilter = patterns.map((p) => `description.ilike.${postgrestFilterValue(`%${p}%`)}`).join(',')
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, description, amount, currency, journal_entry_id')
    .eq('company_id', companyId)
    .eq('is_business', true)
    .gte('date', yearStart)
    .or(orFilter)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as RuleMatch[]
}

/**
 * Change the ladder position. The BEFORE trigger on the table keeps
 * is_active in step, so the booking engine sees the change immediately.
 */
export async function setRuleMode(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  mode: RuleMode,
): Promise<RuleRow | null> {
  const { data, error } = await supabase
    .from('categorization_templates')
    .update({ mode })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, created_at, updated_at')
    .maybeSingle()
  if (error) throw error
  return (data as unknown as RuleRow) ?? null
}
