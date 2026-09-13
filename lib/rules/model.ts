import type { CategorizationTemplateSource, VatTreatment } from '@/types'

/**
 * Regler (UI v2 PR 5, dev_docs/ui_v2_build_plan.md): the pure view of a
 * counterparty template as a rule. The row is categorization_templates; this
 * module derives the ladder position, the origin, the direction and the
 * "when → then" tokens the pages translate. No database access, so both the
 * API and the client components share it.
 */

export type RuleMode = 'proposed' | 'propose' | 'auto' | 'paused'

/** The steps of the trust ladder, in order. Paused sits beside step 2. */
export const RULE_LADDER: readonly RuleMode[] = ['proposed', 'propose', 'auto'] as const

/** Hits without a correction before a rule may book on its own. */
export const AUTO_THRESHOLD = 5

export type RuleOrigin = 'repetition' | 'confirmation' | 'import' | 'system'

export type RuleDirection = 'out' | 'in' | 'transfer' | 'unknown'

export interface RuleRow {
  id: string
  counterparty_name: string
  counterparty_aliases: string[] | null
  debit_account: string
  credit_account: string
  vat_treatment: VatTreatment | null
  vat_account: string | null
  category: string | null
  occurrence_count: number
  corrections: number
  confidence: number
  last_seen_date: string | null
  source: CategorizationTemplateSource
  mode: RuleMode
  paused_at: string | null
  created_at: string
  updated_at: string
}

export interface RuleToken {
  kind: 'counterparty' | 'direction' | 'account' | 'vat' | 'settlement' | 'category'
  value: string
}

/** Where a rule came from, in the user's terms. */
export function ruleOrigin(source: CategorizationTemplateSource): RuleOrigin {
  switch (source) {
    case 'sie_import':
      return 'import'
    case 'sni_default':
      return 'system'
    case 'auto_learned':
      return 'repetition'
    case 'user_approved':
    default:
      return 'confirmation'
  }
}

const isCashAccount = (a: string) => /^19\d\d$/.test(a)

/** Money leaving (debit cost, credit bank), arriving, or moving between own accounts. */
export function ruleDirection(debit: string, credit: string): RuleDirection {
  const debitCash = isCashAccount(debit)
  const creditCash = isCashAccount(credit)
  if (debitCash && creditCash) return 'transfer'
  if (creditCash) return 'out'
  if (debitCash) return 'in'
  return 'unknown'
}

/** The account the rule categorises to: the non-cash side. */
export function ruleCategoryAccount(row: Pick<RuleRow, 'debit_account' | 'credit_account'>): string {
  const dir = ruleDirection(row.debit_account, row.credit_account)
  if (dir === 'in') return row.credit_account
  return row.debit_account
}

/** The "Om" side: what a transaction must look like. */
export function ruleWhen(row: Pick<RuleRow, 'counterparty_name' | 'debit_account' | 'credit_account'>): RuleToken[] {
  const tokens: RuleToken[] = [{ kind: 'counterparty', value: row.counterparty_name }]
  const dir = ruleDirection(row.debit_account, row.credit_account)
  if (dir !== 'unknown') tokens.push({ kind: 'direction', value: dir })
  return tokens
}

/** The "Gör" side: what the rule does with a match. */
export function ruleThen(
  row: Pick<RuleRow, 'debit_account' | 'credit_account' | 'vat_treatment' | 'category'>,
): RuleToken[] {
  const tokens: RuleToken[] = [{ kind: 'account', value: ruleCategoryAccount(row) }]
  if (row.vat_treatment) tokens.push({ kind: 'vat', value: row.vat_treatment })
  const dir = ruleDirection(row.debit_account, row.credit_account)
  tokens.push({ kind: 'settlement', value: dir === 'in' ? row.debit_account : row.credit_account })
  return tokens
}

/** 0-based step on the ladder. A paused rule shows at the confirmed step. */
export function ruleStep(mode: RuleMode): number {
  if (mode === 'paused') return 1
  return RULE_LADDER.indexOf(mode)
}

/** Clean hits (hits minus corrections) still needed before the auto step. */
export function hitsUntilAuto(
  row: Pick<RuleRow, 'occurrence_count' | 'corrections'>,
  threshold = AUTO_THRESHOLD,
): number {
  return Math.max(0, threshold - (row.occurrence_count - row.corrections))
}

/** Modes a user may set from the UI today. 'auto' waits for the autopilot tier. */
export const USER_SETTABLE_MODES: readonly RuleMode[] = ['propose', 'paused'] as const

/**
 * Aliases as a safe PostgREST ilike filter list: only letters, digits, space,
 * dot and dash survive, so no alias can smuggle a filter operator.
 */
/**
 * A value for a PostgREST filter, double-quoted with backslash escapes, so a
 * period, comma or parenthesis inside a counterparty alias ("booking.com",
 * "Restaurang Nunnan (Bageriet)") is read as text and never as filter syntax.
 */
export function postgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function aliasPatterns(row: Pick<RuleRow, 'counterparty_name' | 'counterparty_aliases'>): string[] {
  const raw = [row.counterparty_name, ...(row.counterparty_aliases ?? [])]
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    const cleaned = r.replace(/[^\p{L}\p{N} .-]/gu, ' ').replace(/\s+/g, ' ').trim()
    if (cleaned.length < 2) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= 8) break
  }
  return out
}
