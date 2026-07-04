/**
 * Account dimension rules (dimensions PR10) — the policy layer over the
 * dimensions substrate. Rules live in account_dimension_rules
 * (20260703200000), one per (account, dimension):
 *
 *   'required'  the account cannot be POSTED without a value → enforced by
 *               assertMandatoryDimensions at commitEntry and the bulk-book
 *               route pre-check. Drafts may be incomplete by design; storno/
 *               correction paths never pass through commitEntry, so history
 *               always reverses regardless of policy.
 *   'default'   pre-applied to the line bag at draft creation when the key
 *               is absent (user-overridable).
 *   'fixed'     ALWAYS applied at draft creation (overwrites the caller's
 *               key) — the account is pinned to one value.
 *
 * Zero rules (every company by default) short-circuits everything — the
 * engine behaves exactly as before PR10. Rule fetches FAIL OPEN like the
 * soft registry validation: a transient DB error must not block bookkeeping,
 * and the write hits the same database anyway.
 *
 * Pure of next/server so it stays importable from anywhere the resolver is.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MandatoryDimensionMissingError,
  type MandatoryDimensionViolation,
} from './dimension-errors'
import {
  normalizeLineDimensions,
  type DimensionAliasInput,
  type LineDimensions,
} from './dimension-resolver'

export interface AccountDimensionRule {
  account_number: string
  rule_type: 'required' | 'default' | 'fixed'
  /** Canonical SIE dimension number as a string key, e.g. '6'. */
  sie_dim_no: string
  dimension_name: string
  /** Value code for default/fixed rules; null for required. */
  value_code: string | null
}

interface RawRuleRow {
  account_number: string
  rule_type: 'required' | 'default' | 'fixed'
  dimensions: { sie_dim_no: number; name: string }
  dimension_values: { code: string } | null
}

/**
 * All ACTIVE rules for the company. Returns null on query failure (callers
 * fail open — same posture as validateEntryDimensions). The table is tiny
 * and indexed on (company_id, account_number); one fetch per booking is the
 * whole cost for rule-less companies.
 */
export async function fetchActiveDimensionRules(
  supabase: SupabaseClient,
  companyId: string
): Promise<AccountDimensionRule[] | null> {
  // try/catch on top of the error-result check: fail-open must also cover
  // thrown exceptions (broken client, network throw) — policy lookups are
  // never allowed to take bookkeeping down with them.
  try {
    const { data, error } = await supabase
      .from('account_dimension_rules')
      .select(
        'account_number, rule_type, dimensions!account_dimension_rules_dimension_id_company_id_fkey(sie_dim_no, name), dimension_values!account_dimension_rules_value_id_fkey(code)'
      )
      .eq('company_id', companyId)
      .eq('is_active', true)

    if (error) return null

    return ((data ?? []) as unknown as RawRuleRow[]).map((row) => ({
      account_number: row.account_number,
      rule_type: row.rule_type,
      sie_dim_no: String(row.dimensions.sie_dim_no),
      dimension_name: row.dimensions.name,
      value_code: row.dimension_values?.code ?? null,
    }))
  } catch {
    return null
  }
}

/**
 * Apply default/fixed rules onto entry lines before validation + insert.
 * Returns the same array when nothing applies (zero allocation on the
 * common path); otherwise a copy where affected lines carry the augmented
 * bag (aliases folded in first, so the returned lines are bag-authoritative).
 */
export function applyDimensionRules<
  T extends DimensionAliasInput & { account_number: string },
>(lines: T[], rules: AccountDimensionRule[]): T[] {
  const applicable = rules.filter(
    (r) => (r.rule_type === 'default' || r.rule_type === 'fixed') && r.value_code
  )
  if (applicable.length === 0) return lines

  const byAccount = new Map<string, AccountDimensionRule[]>()
  for (const rule of applicable) {
    const bucket = byAccount.get(rule.account_number) ?? []
    bucket.push(rule)
    byAccount.set(rule.account_number, bucket)
  }

  let anyChanged = false
  const result = lines.map((line) => {
    const forAccount = byAccount.get(line.account_number)
    if (!forAccount) return line

    const bag: LineDimensions = normalizeLineDimensions(line)
    let changed = false
    for (const rule of forAccount) {
      if (rule.rule_type === 'fixed') {
        if (bag[rule.sie_dim_no] !== rule.value_code) {
          bag[rule.sie_dim_no] = rule.value_code as string
          changed = true
        }
      } else if (!(rule.sie_dim_no in bag)) {
        bag[rule.sie_dim_no] = rule.value_code as string
        changed = true
      }
    }
    if (!changed) return line
    anyChanged = true
    // The bag now carries everything (aliases folded by normalize) — clear
    // the deprecated aliases so downstream normalization can't resurrect a
    // value a fixed rule just overwrote.
    return { ...line, dimensions: bag, cost_center: null, project: null }
  })

  return anyChanged ? result : lines
}

/**
 * Throw MandatoryDimensionMissingError when any ACTIVE 'required' rule is
 * unsatisfied. One violation per (account, dimension) regardless of how many
 * lines miss it — the Swedish message stays readable for multi-line entries.
 */
export function assertMandatoryDimensions(
  lines: Array<DimensionAliasInput & { account_number: string }>,
  rules: AccountDimensionRule[]
): void {
  const required = rules.filter((r) => r.rule_type === 'required')
  if (required.length === 0) return

  const byAccount = new Map<string, AccountDimensionRule[]>()
  for (const rule of required) {
    const bucket = byAccount.get(rule.account_number) ?? []
    bucket.push(rule)
    byAccount.set(rule.account_number, bucket)
  }

  const violations = new Map<string, MandatoryDimensionViolation>()
  for (const line of lines) {
    const forAccount = byAccount.get(line.account_number)
    if (!forAccount) continue
    const bag = normalizeLineDimensions(line)
    for (const rule of forAccount) {
      if (!bag[rule.sie_dim_no]) {
        violations.set(`${line.account_number} ${rule.sie_dim_no}`, {
          account_number: line.account_number,
          sie_dim_no: rule.sie_dim_no,
          dimension_name: rule.dimension_name,
        })
      }
    }
  }

  if (violations.size > 0) {
    throw new MandatoryDimensionMissingError([...violations.values()])
  }
}

/**
 * Source types EXEMPT from dimension rules — system-generated and
 * correction-instrument entries where policy must never bite:
 *
 *   - historical/derived data (SIE import, opening balances) must land
 *     verbatim — injecting defaults or refusing untagged history would
 *     falsify the record (BFL 5 kap)
 *   - year-end and revaluation are system bokslut mechanics; a rule on a
 *     result account must not be able to block closing the year
 *   - storno/correction/credit notes are HOW history gets fixed — blocking
 *     them on entries that pre-date a rule would make old mistakes
 *     permanent (same argument as the commitEntry bypass for reversals).
 *     Credit notes specifically COPY the original's bags (PR7) so the
 *     reversal nets against the same dimension cells: if the original
 *     satisfied the rules, so does the copy (enforcement = no-op); if the
 *     original pre-dates the rules, enforcing would demand an ASYMMETRIC
 *     tag — a credit in P001 with no original in P001 — which is exactly
 *     the project-P&L skew this feature exists to prevent
 *   - accrual dissolutions replay a schedule created before the rule
 *
 * Operational sources (manual, bank_transaction, invoice_*, supplier_*
 * registrations/payments, salary_payment) stay enforced — those are the
 * new business events the policy exists for.
 */
export const DIMENSION_RULE_EXEMPT_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'opening_balance',
  'import',
  'year_end',
  'storno',
  'correction',
  'credit_note',
  'supplier_credit_note',
  'currency_revaluation',
  'system',
])

export function isDimensionRuleExemptSource(sourceType: string | null | undefined): boolean {
  return sourceType != null && DIMENSION_RULE_EXEMPT_SOURCE_TYPES.has(sourceType)
}
