import type { SupabaseClient } from '@supabase/supabase-js'
import type { CategorizationTemplate } from '@/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { aliasPatterns, postgrestFilterValue, type RuleMode, type RuleRow } from './model'
import { stockholmYearMonth } from '@/lib/dates/iso'

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
    always_review: false,
  } as unknown as RuleRow
}

/**
 * Before migration 20261030131517 the table has no always_review (the code
 * is live a few minutes before it runs): no rule asks on its own yet.
 */
function withoutAlwaysReview(row: Record<string, unknown>): RuleRow {
  return { ...row, always_review: false } as unknown as RuleRow
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
        .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, always_review, created_at, updated_at')
        .eq('company_id', companyId)
        .order('occurrence_count', { ascending: false })
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to),
    )
  } catch (error) {
    if ((error as { code?: string }).code !== UNDEFINED_COLUMN) throw error
  }
  try {
    const ladder = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('categorization_templates')
        .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, created_at, updated_at')
        .eq('company_id', companyId)
        .order('occurrence_count', { ascending: false })
        .order('updated_at', { ascending: false })
        .order('id')
        .range(from, to),
    )
    return ladder.map(withoutAlwaysReview)
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
    .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, always_review, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error && error.code === UNDEFINED_COLUMN) {
    const ladder = await supabase
      .from('categorization_templates')
      .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, created_at, updated_at')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()
    if (!ladder.error) return ladder.data ? withoutAlwaysReview(ladder.data as Record<string, unknown>) : null
    if (ladder.error.code !== UNDEFINED_COLUMN) throw ladder.error
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
  const yearStart = `${stockholmYearMonth(now).year}-01-01`
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

/** What a person may change on a rule: its ladder position, and whether it always asks. */
export interface RuleChange {
  mode?: RuleMode
  always_review?: boolean
}

/**
 * Change a rule. The BEFORE trigger on the table keeps is_active in step
 * with mode, so the booking engine sees the change immediately; the audit
 * trigger logs both (always_review is a rule change in the
 * behandlingshistorik, not a learning column).
 */
export async function updateRule(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  change: RuleChange,
): Promise<RuleRow | null> {
  const { data, error } = await supabase
    .from('categorization_templates')
    // A key left undefined is not sent (the body is JSON), so only what changed is written.
    .update({ mode: change.mode, always_review: change.always_review })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account, vat_treatment, vat_account, category, occurrence_count, corrections, confidence, last_seen_date, source, mode, paused_at, always_review, created_at, updated_at')
    .maybeSingle()
  if (error) throw error
  return (data as unknown as RuleRow) ?? null
}

/**
 * Stored names are lowercase, single-spaced keys (the matcher compares them
 * against normalized bank descriptions). A typed name gets the same shape;
 * display re-capitalizes through formatCounterpartyName().
 */
export function counterpartyTemplateKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Why a rename was refused: the name is shorter than two characters, the
 * template is not an active one of the company, or another active template
 * already has the name.
 */
export type RenameRefusal = 'NAME_TOO_SHORT' | 'NOT_FOUND' | 'NAME_TAKEN'

export type RenameOutcome =
  | { ok: true; template: CategorizationTemplate; changed: boolean; previousName: string }
  | { ok: false; reason: RenameRefusal }

/**
 * Rename an active counterparty template (a rule), for the settings panel and
 * the agent's gnubok_rename_counterparty_template alike. The old name is kept
 * as an alias so both the matcher (alias tier) and the learn path
 * (findTemplateByKey) keep landing on this row for the merchant it was
 * learned from. A dry run reads and refuses as the rename would, and answers
 * the template as it would be, without writing. A failed read or write throws
 * the database error.
 */
export async function renameCounterpartyTemplate(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  name: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<RenameOutcome> {
  const newName = counterpartyTemplateKey(name)
  if (newName.length < 2) return { ok: false, reason: 'NAME_TOO_SHORT' }

  const { data: existing, error: fetchError } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()
  if (fetchError) throw fetchError
  if (!existing) return { ok: false, reason: 'NOT_FOUND' }
  const current = existing as CategorizationTemplate
  const previousName = current.counterparty_name
  if (previousName === newName) return { ok: true, template: current, changed: false, previousName }

  // (company_id, counterparty_name) is UNIQUE and includes soft-deleted
  // rows. An active twin is a real conflict the user can see and resolve;
  // an inactive twin is invisible to them, so it is removed instead of
  // blocking the rename (a learned pattern, not a retention-bound record).
  const { data: twin, error: twinError } = await supabase
    .from('categorization_templates')
    .select('id, is_active')
    .eq('company_id', companyId)
    .eq('counterparty_name', newName)
    .neq('id', id)
    .maybeSingle()
  if (twinError) throw twinError
  if (twin?.is_active) return { ok: false, reason: 'NAME_TAKEN' }

  const aliases = [...(current.counterparty_aliases || [])]
  if (!aliases.includes(current.counterparty_name)) aliases.push(current.counterparty_name)

  if (dryRun) {
    return {
      ok: true,
      template: { ...current, counterparty_name: newName, counterparty_aliases: aliases },
      changed: true,
      previousName,
    }
  }

  if (twin) {
    const { error: purgeError } = await supabase
      .from('categorization_templates')
      .delete()
      .eq('id', twin.id)
      .eq('company_id', companyId)
    if (purgeError) throw purgeError
  }

  const { data: updated, error: updateError } = await supabase
    .from('categorization_templates')
    .update({ counterparty_name: newName, counterparty_aliases: aliases })
    .eq('id', id)
    .eq('company_id', companyId)
    .select('*')
    .single()
  if (updateError) {
    // Lost the race against another rename or the learn path: the unique
    // (company_id, counterparty_name) index rejected the new name.
    if ((updateError as { code?: string }).code === '23505') return { ok: false, reason: 'NAME_TAKEN' }
    throw updateError
  }
  return { ok: true, template: updated as CategorizationTemplate, changed: true, previousName }
}
