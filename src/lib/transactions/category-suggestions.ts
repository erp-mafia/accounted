import { suggestCategory } from '@/lib/tax/expense-warnings'
import { getExpenseAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import {
  hasUnknownVat,
  namesCounterparty,
  normalizeCounterpartyName,
  formatCounterpartyName,
  mappingPatternNamesCounterparty,
  toCounterpartyTemplateId,
} from '@/lib/bookkeeping/counterparty-templates'
import { BOOKING_TEMPLATES, findMatchingTemplates, getTemplateById, templateAppliesToForm, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { proposalFromTemplate, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { isSkatteverketPayment } from '@/lib/bookkeeping/skatteverket-payment'
import { isCashLedger, mappingRuleAccount } from '@/lib/bookkeeping/bank-leg'
import { ruleReviewFlags } from './direct-booking'
import type {
  Transaction,
  TransactionCategory,
  EntityType,
  MappingRule,
  CategorizationTemplate,
} from '@/types'

export interface SuggestedCategory {
  category: TransactionCategory
  label: string
  account: string | null
  confidence: number
  source: 'mapping_rule' | 'pattern' | 'history'
  match_reason?: string
}

const CATEGORY_LABELS: Record<string, string> = {
  income_services: 'Tjänster',
  income_products: 'Produkter',
  income_other: 'Övriga intäkter',
  expense_equipment: 'Utrustning',
  expense_software: 'Programvara',
  expense_travel: 'Resor',
  expense_office: 'Kontor',
  expense_marketing: 'Marknadsföring',
  expense_professional_services: 'Konsulter',
  expense_education: 'Utbildning',
  expense_representation: 'Representation',
  expense_consumables: 'Material',
  expense_vehicle: 'Bil & drivmedel',
  expense_telecom: 'Telefon & internet',
  expense_bank_fees: 'Bankavgift',
  expense_card_fees: 'Kortavgift',
  expense_currency_exchange: 'Valutaväxling',
  expense_other: 'Övrigt',
}

/**
 * Counterparty-keyed history: normalized merchant name -> category counts.
 * Built once per request from the caller's recent categorized transactions.
 */
export type MerchantHistoryMap = Map<string, Record<string, number>>

/**
 * History keys share the counterparty-template normalization so card
 * descriptors ("ANTHROPIC* CLAUDE SUB SAN FRANCISCO") and clean merchant
 * names ("Anthropic") aggregate under one key. merchant_name is null on card
 * purchases (bank feeds only carry counterparty names for transfers), so the
 * descriptor is the fallback identity: without it, card merchants have no
 * history at all and every recurring foreign SaaS line reads as no-signal.
 * Callers pass `original_description ?? description`: the raw bank descriptor
 * is the stable anchor, `description` is a user-editable working title that
 * would sever the link on rename.
 *
 * A text that names no one has no key, as it has no learned counterpart
 * (namesCounterparty, the rule findCounterpartyTemplatesBatch matches by):
 * "INTERNET BET 1" is the bank's wording for an internet payment, whoever
 * was paid, so one key pooled the tags of every such payment and offered
 * them for the next one (crm#1920). Both the build and the lookup pass here.
 */
function normalizeMerchantKey(
  merchantName: string | null | undefined,
  descriptor?: string | null,
): string {
  const raw = (merchantName ?? '').trim() || (descriptor ?? '').trim()
  if (!raw || !namesCounterparty(raw)) return ''
  const key = normalizeCounterpartyName(raw)
  return key.length >= 2 ? key : ''
}

/**
 * `is_booked` is the row's own answer to "does a live verifikat book it"
 * (public.bank_row_anchors, see lib/transactions/unbooked.ts). A row that
 * says no is not counted: its tag outlives a verifikat reversed from the
 * ledger, and the learned counterpart forgets that booking too
 * (unlearnCounterpartyTemplate), so the history said "booked before" about
 * a booking that was taken back (crm#1920).
 */
export function buildMerchantHistory(
  rows: Array<{
    merchant_name: string | null
    description?: string | null
    original_description?: string | null
    category: string | null
    is_booked?: boolean | null
  }>,
): MerchantHistoryMap {
  const map: MerchantHistoryMap = new Map()
  for (const row of rows) {
    if (row.is_booked === false) continue
    const key = normalizeMerchantKey(
      row.merchant_name,
      row.original_description ?? row.description,
    )
    if (!key || !row.category) continue
    const bucket = map.get(key) ?? {}
    bucket[row.category] = (bucket[row.category] || 0) + 1
    map.set(key, bucket)
  }
  return map
}

export function merchantHistoryFor(
  map: MerchantHistoryMap,
  merchantName: string | null | undefined,
  descriptor?: string | null,
): Record<string, number> {
  const key = normalizeMerchantKey(merchantName, descriptor)
  return key ? (map.get(key) ?? {}) : {}
}

/**
 * Get suggested categories for a transaction.
 * Combines mapping rules, pattern matching, and counterparty history.
 *
 * merchantHistory is the category history FOR THIS TRANSACTION'S counterparty
 * (see buildMerchantHistory/merchantHistoryFor): never a company-wide
 * frequency map. Global padding produced identical ~0.5 four-way spreads on
 * every transaction, which agents correctly read as no signal; an empty
 * result is the honest answer.
 */
/**
 * Whether a mapping rule's pattern (merchant, description, or MCC) hits this
 * transaction. A rule on a merchant text that names no one ("INSÄTTNING"),
 * stored before saveUserMappingRule refused to learn one, hits nothing: the
 * mapping engine's matchesRule skips it the same way (crm#1707).
 */
export function mappingRuleMatches(
  rule: Pick<MappingRule, 'merchant_pattern' | 'description_pattern' | 'mcc_codes'>,
  transaction: Pick<Transaction, 'merchant_name' | 'description' | 'mcc_code'>,
): boolean {
  if (rule.merchant_pattern && !mappingPatternNamesCounterparty(rule.merchant_pattern)) return false
  if (rule.merchant_pattern && transaction.merchant_name) {
    if (new RegExp(rule.merchant_pattern, 'i').test(transaction.merchant_name)) return true
  }
  if (rule.description_pattern) {
    if (new RegExp(rule.description_pattern, 'i').test(transaction.description)) return true
  }
  if (rule.mcc_codes && transaction.mcc_code) {
    if (rule.mcc_codes.includes(transaction.mcc_code)) return true
  }
  return false
}

export function getSuggestedCategories(
  transaction: Transaction,
  mappingRules: MappingRule[],
  merchantHistory: Record<string, number>
): SuggestedCategory[] {
  const suggestions: SuggestedCategory[] = []
  const seen = new Set<string>()

  // 1. Check mapping rules (highest confidence)
  for (const rule of mappingRules) {
    if (!rule.is_active) continue

    const matches = mappingRuleMatches(rule, transaction)
    const ruleAccount = mappingRuleAccount(rule)

    if (matches && ruleAccount && !rule.default_private) {
      // Reverse-lookup: find category from debit account. A rule booking on
      // an account outside the fixed maps (company-custom accounts like VMB)
      // must still surface: the account itself is the signal, and callers
      // reach it via account_override. Fall back to the direction's generic
      // category instead of silently dropping the rule.
      const mapped = accountToCategory(ruleAccount, transaction.amount)
      const category = mapped ?? (transaction.amount < 0 ? 'expense_other' : 'income_other')
      if (!seen.has(category)) {
        seen.add(category)
        const suggestion: SuggestedCategory = {
          category: category as TransactionCategory,
          label: CATEGORY_LABELS[category] || category,
          account: ruleAccount,
          confidence: rule.confidence_score || 0.8,
          source: 'mapping_rule',
        }
        const reasons: string[] = []
        if (rule.source === 'user_description' && rule.user_description) {
          reasons.push(`Matchad på din beskrivning: ${rule.user_description}`)
        }
        if (!mapped) {
          reasons.push(`Regeln bokför på konto ${ruleAccount} (utanför standardkategorierna)`)
        }
        if (reasons.length > 0) {
          suggestion.match_reason = reasons.join('. ')
        }
        suggestions.push(suggestion)
      }
    }
  }

  // 2. Pattern matching from expense-warnings
  const patternMatch = suggestCategory(transaction.description)
  if (patternMatch && !seen.has(patternMatch)) {
    seen.add(patternMatch)
    suggestions.push({
      category: patternMatch as TransactionCategory,
      label: CATEGORY_LABELS[patternMatch] || patternMatch,
      account: getExpenseAccountForCategory(patternMatch as TransactionCategory),
      confidence: 0.6,
      source: 'pattern',
    })
  }

  // 3. Counterparty history: categories this merchant was booked as before.
  // Confidence scales with occurrences and the reason carries provenance.
  // A payment to Skatteverket books on the skattekonto by rule
  // (leadWithSkattekonto in ./propose.ts), never by habit: no history is
  // offered for it, as no learned counterpart is (crm#1275). The catalog
  // template that books it tags the row expense_other, which read back here
  // as 6991 (crm#1920).
  const history: Record<string, number> = isSkatteverketPayment(transaction) ? {} : merchantHistory
  const historyEntries = Object.entries(history)
    .sort(([, a], [, b]) => b - a)
    .filter(([cat]) => !seen.has(cat))

  for (const [cat, count] of historyEntries) {
    if (suggestions.length >= 4) break
    // Only suggest relevant direction (expense for negative, income for positive)
    if (transaction.amount < 0 && !cat.startsWith('expense_')) continue
    if (transaction.amount > 0 && !cat.startsWith('income_')) continue

    seen.add(cat)
    suggestions.push({
      category: cat as TransactionCategory,
      label: CATEGORY_LABELS[cat] || cat,
      account: getExpenseAccountForCategory(cat as TransactionCategory),
      // 1 previous booking -> 0.56, capped at 0.85 (history informs, a human
      // or counterparty template confirms).
      confidence: Math.min(0.85, 0.5 + count * 0.06),
      source: 'history',
      match_reason: `Bokförd ${count} gång${count === 1 ? '' : 'er'} tidigare för denna motpart`,
    })
  }

  // Sort by confidence, limit to top 4
  return suggestions
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4)
}

/**
 * Reverse-lookup: find category from BAS account number
 */
function accountToCategory(account: string, amount: number): string | null {
  if (amount > 0) {
    // Income. Unknown accounts return null (not a blanket 'income_other') so
    // the caller can tell a mapped account from a custom one and attach the
    // custom-account diagnostic; the caller's fallback still lands on
    // income_other, so the surfaced category is unchanged.
    const incomeMap: Record<string, string> = {
      '3001': 'income_services',
      '3900': 'income_other',
    }
    return incomeMap[account] || null
  }

  // Expense
  const expenseMap: Record<string, string> = {
    '5410': 'expense_equipment',
    '5420': 'expense_software',
    '5460': 'expense_consumables',
    '5611': 'expense_vehicle',
    '5800': 'expense_travel',
    '5010': 'expense_office',
    '5910': 'expense_marketing',
    '6071': 'expense_representation',
    '6072': 'expense_representation',
    '6200': 'expense_telecom',
    '6530': 'expense_professional_services',
    '6570': 'expense_bank_fees',
    '6991': 'expense_other',
    '7960': 'expense_currency_exchange',
  }
  return expenseMap[account] || null
}

// ============================================================
// Template Suggestions
// ============================================================

/**
 * A row suggestion is a BookingProposal (lib/bookkeeping/proposal.ts): the
 * one object every source produces and every surface consumes. 'rule' is a
 * mapping rule that MATCHED this transaction; 'recent' is a template a rule
 * points at, offered because it was used lately, not because anything
 * matched; 'counterparty' is the learned per-counterpart rule
 * (categorization_templates); 'assistant' is the model's read.
 */
export type SuggestedTemplate = BookingProposal

/**
 * Get recently used templates from mapping rules.
 * Extracts unique template_id values and returns them as suggestions.
 */
export function getRecentlyUsedTemplates(
  mappingRules: MappingRule[],
  entityType?: EntityType,
  direction?: 'expense' | 'income' | 'transfer'
): SuggestedTemplate[] {
  const seen = new Set<string>()
  const results: SuggestedTemplate[] = []

  // Sort by most recent (highest priority first)
  const sorted = [...mappingRules]
    .filter((r) => r.is_active && r.template_id)
    .sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))

  for (const rule of sorted) {
    if (!rule.template_id || seen.has(rule.template_id)) continue
    seen.add(rule.template_id)

    const template = getTemplateById(rule.template_id)
    if (!template) continue

    // Filter by entity applicability
    if (entityType && !templateAppliesToForm(template, entityType)) continue

    // Filter by direction
    if (direction && template.direction !== direction && template.direction !== 'transfer') continue

    // Used lately, not matched: below any keyword match (at most 0.3), and
    // never the row's chip (rowProposal skips it); the picker still lists it.
    results.push(proposalFromTemplate(template, 'recent', 0.1))

    if (results.length >= 5) break
  }

  return results
}

/**
 * The proposals of the mapping rules that match this row, one per template,
 * in the rules' order: the template the rule names, or the catalog template
 * booking to the rule's account. A rule that matches but resolves to no
 * template proposes nothing.
 */
export function matchedRuleProposals(
  transaction: Transaction,
  entityType: EntityType | undefined,
  mappingRules: MappingRule[],
): SuggestedTemplate[] {
  const seen = new Set<string>()
  const results: SuggestedTemplate[] = []
  const direction = transaction.amount < 0 ? 'expense' : 'income'
  for (const rule of mappingRules) {
    if (!rule.is_active || rule.default_private) continue
    if (!mappingRuleMatches(rule, transaction)) continue
    // A rule whose account is a bank ledger (a transfer between own accounts)
    // names no catalog template: every template that books to the bank on its
    // other side is other money, a loan, an owner's deposit or share capital.
    const ruleAccount = mappingRuleAccount(rule)
    const template =
      (rule.template_id ? getTemplateById(rule.template_id) : undefined) ??
      (ruleAccount && !isCashLedger(ruleAccount) ? templateForAccount(ruleAccount, direction, entityType) : undefined)
    if (!template || seen.has(template.id)) continue
    seen.add(template.id)
    results.push({
      ...proposalFromTemplate(template, 'rule', Math.max(rule.confidence_score || 0, 0.9)),
      rule_own: !!rule.company_id,
      rule_requires_review: !!rule.requires_review,
      requires_review: template.requires_review || !!rule.requires_review,
    })
  }
  return results
}

/**
 * Get suggested booking templates for a transaction.
 * Keyword matching as primary, AI embedding search as optional enhancer.
 */
export async function getSuggestedTemplates(
  transaction: Transaction,
  entityType?: EntityType,
  mappingRules?: MappingRule[]
): Promise<SuggestedTemplate[]> {
  const direction = transaction.amount < 0 ? 'expense' : 'income'

  // 0. The company's rules that match this row.
  const results: SuggestedTemplate[] = mappingRules ? matchedRuleProposals(transaction, entityType, mappingRules) : []
  const seen = new Set<string>(results.map((r) => r.template_id))

  // 1. Templates the company's rules point at, used lately
  if (mappingRules) {
    const recent = getRecentlyUsedTemplates(mappingRules, entityType, direction)
    for (const r of recent) {
      if (!seen.has(r.template_id)) {
        seen.add(r.template_id)
        results.push(r)
      }
    }
  }

  // 2. Keyword + MCC matching (always available, no API keys needed)
  const keywordMatches = findMatchingTemplates(transaction, entityType)
  for (const m of keywordMatches) {
    if (!seen.has(m.template.id)) {
      seen.add(m.template.id)
      results.push(proposalFromTemplate(m.template, 'catalog', m.confidence))
    }
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10)
}

/**
 * Shape a learned counterparty template into the suggestion the transaction
 * modal renders under "Tidigare motparter".
 *
 * Every field the review dialog later reads has to come across here: the
 * dialog books through `counterparty_template_id`, so the accounts and VAT it
 * previews must be the template's own, not the transaction category's
 * fallbacks. A suggestion that omitted them previously left the dialog with an
 * undefined default account, which crashed the page.
 */
/**
 * The suggestion a row wears as its chip and books from its Bokför: the
 * first one that matched the row itself. A template merely used lately is
 * a picker convenience, not a recommendation. Neither is a weak counterpart
 * match the assistant's read booked differently: the row then recommends
 * nothing, and what follows the match is not moved up in its place, so the
 * read can take a suggestion down but never put itself on the row.
 */
export function rowProposal(list: SuggestedTemplate[] | undefined): SuggestedTemplate | undefined {
  const first = list?.find((s) => s.source !== 'recent')
  return first?.contested ? undefined : first
}

/** The catalog template that books to this account in this direction, if one does. */
function templateForAccount(account: string, direction: 'expense' | 'income', entityType?: EntityType): BookingTemplate | undefined {
  return BOOKING_TEMPLATES.find(
    (t) =>
      (t.direction === direction || t.direction === 'transfer') &&
      (direction === 'expense' ? t.debit_account : t.credit_account) === account &&
      (!entityType || templateAppliesToForm(t, entityType)),
  )
}

/**
 * `directionMismatch` (contradictsLearnedDirection, decided by the caller on
 * the stored template, as the booking decides it): the row's money moves
 * against the template's learned direction, likely a refund. The legs are
 * shown mirrored, as buildMappingResultFromCounterpartyTemplate books them,
 * and it never books without a review (crm#1598).
 */
export function buildCounterpartySuggestion(
  template: CategorizationTemplate,
  confidence: number,
  opts: { directionMismatch?: boolean } = {},
): SuggestedTemplate {
  const proposal = counterpartyProposal(template, confidence)
  if (!opts.directionMismatch) return proposal
  return {
    ...proposal,
    debit_account: proposal.credit_account,
    credit_account: proposal.debit_account,
    description_sv: `${template.occurrence_count} tidigare bokföringar åt andra hållet: trolig återbetalning`,
    requires_review: true,
    direction_mismatch: true,
  }
}

function counterpartyProposal(template: CategorizationTemplate, confidence: number): SuggestedTemplate {
  // Moms of no one rate (hasUnknownVat): the template books none of its own,
  // so the underlag's moms is stated in a review, never assumed to be none.
  const vatUnknown = hasUnknownVat(template)
  return {
    template_id: toCounterpartyTemplateId(template.id),
    source: 'counterparty',
    booking: { kind: 'counterparty', counterparty_template_id: template.id },
    seen_count: template.occurrence_count,
    rule_mode: template.mode,
    ...ruleReviewFlags(template),
    name_sv: formatCounterpartyName(template.counterparty_name),
    name_en: formatCounterpartyName(template.counterparty_name),
    group: 'counterparty',
    debit_account: template.debit_account,
    credit_account: template.credit_account,
    confidence,
    description_sv: `${template.occurrence_count} tidigare bokföringar`,
    risk_level: 'NONE',
    requires_review: vatUnknown,
    ...(vatUnknown ? { vat_unknown: true } : {}),
    line_pattern: template.line_pattern ?? null,
    // Single-line templates book net expense + input VAT from this treatment
    // (buildMappingResultFromCounterpartyTemplate); the review dialog needs it
    // to preview the same verifikation.
    vat_treatment: template.vat_treatment === 'unknown' ? null : (template.vat_treatment ?? null),
    default_dimensions:
      template.default_dimensions && Object.keys(template.default_dimensions).length > 0
        ? template.default_dimensions
        : null,
  }
}
