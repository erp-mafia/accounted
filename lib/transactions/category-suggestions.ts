import { suggestCategory } from '@/lib/tax/expense-warnings'
import { getExpenseAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import { findMatchingTemplates, getTemplateById, type TemplateMatch } from '@/lib/bookkeeping/booking-templates'
import type { Transaction, TransactionCategory, EntityType, MappingRule, LinePatternEntry } from '@/types'

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

function normalizeMerchantKey(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().trim()
}

export function buildMerchantHistory(
  rows: Array<{ merchant_name: string | null; category: string | null }>,
): MerchantHistoryMap {
  const map: MerchantHistoryMap = new Map()
  for (const row of rows) {
    const key = normalizeMerchantKey(row.merchant_name)
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
): Record<string, number> {
  const key = normalizeMerchantKey(merchantName)
  return key ? (map.get(key) ?? {}) : {}
}

/**
 * Get suggested categories for a transaction.
 * Combines mapping rules, pattern matching, and counterparty history.
 *
 * merchantHistory is the category history FOR THIS TRANSACTION'S counterparty
 * (see buildMerchantHistory/merchantHistoryFor): never a company-wide
 * frequency map. Global padding produced identical ~0.5 four-way spreads on
 * every transaction, which agents correctly read as no signal
 * (mcp_optimization_plan P2-1); an empty result is the honest answer.
 */
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

    let matches = false

    if (rule.merchant_pattern && transaction.merchant_name) {
      const pattern = new RegExp(rule.merchant_pattern, 'i')
      if (pattern.test(transaction.merchant_name)) {
        matches = true
      }
    }

    if (rule.description_pattern) {
      const pattern = new RegExp(rule.description_pattern, 'i')
      if (pattern.test(transaction.description)) {
        matches = true
      }
    }

    if (rule.mcc_codes && transaction.mcc_code) {
      if (rule.mcc_codes.includes(transaction.mcc_code)) {
        matches = true
      }
    }

    if (matches && rule.debit_account && !rule.default_private) {
      // Reverse-lookup: find category from debit account
      const category = accountToCategory(rule.debit_account, transaction.amount)
      if (category && !seen.has(category)) {
        seen.add(category)
        const suggestion: SuggestedCategory = {
          category: category as TransactionCategory,
          label: CATEGORY_LABELS[category] || category,
          account: rule.debit_account,
          confidence: rule.confidence_score || 0.8,
          source: 'mapping_rule',
        }
        if (rule.source === 'user_description' && rule.user_description) {
          suggestion.match_reason = `Matchad på din beskrivning: ${rule.user_description}`
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
  const historyEntries = Object.entries(merchantHistory)
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
    // Income
    const incomeMap: Record<string, string> = {
      '3001': 'income_services',
      '3900': 'income_other',
    }
    return incomeMap[account] || 'income_other'
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

export interface SuggestedTemplate {
  template_id: string
  name_sv: string
  name_en: string
  group: string
  debit_account: string
  credit_account: string
  confidence: number
  description_sv: string
  risk_level: string
  requires_review: boolean
  line_pattern?: LinePatternEntry[] | null
}

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
    if (entityType && template.entity_applicability !== 'all' && template.entity_applicability !== entityType) continue

    // Filter by direction
    if (direction && template.direction !== direction && template.direction !== 'transfer') continue

    results.push({
      template_id: template.id,
      name_sv: template.name_sv,
      name_en: template.name_en,
      group: template.group,
      debit_account: template.debit_account,
      credit_account: template.credit_account,
      confidence: 0.85,
      description_sv: template.description_sv,
      risk_level: template.risk_level,
      requires_review: template.requires_review,
    })

    if (results.length >= 5) break
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
  const seen = new Set<string>()
  const results: SuggestedTemplate[] = []

  // 1. Boost recently-used templates from mapping rules
  if (mappingRules) {
    const direction = transaction.amount < 0 ? 'expense' : 'income'
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
      results.push({
        template_id: m.template.id,
        name_sv: m.template.name_sv,
        name_en: m.template.name_en,
        group: m.template.group,
        debit_account: m.template.debit_account,
        credit_account: m.template.credit_account,
        confidence: m.confidence,
        description_sv: m.template.description_sv,
        risk_level: m.template.risk_level,
        requires_review: m.template.requires_review,
      })
    }
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10)
}
