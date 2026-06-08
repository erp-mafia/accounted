import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generateInputVatLine,
  generateReverseChargeLines,
  generateReverseChargeBasisLines,
} from './vat-entries'
import { findMatchingTemplates, buildMappingResultFromTemplate } from './booking-templates'
import {
  findCounterpartyTemplate,
  buildMappingResultFromCounterpartyTemplate,
} from './counterparty-templates'
import { detectOwnAccountTransfer } from './own-account-detector'
import type {
  MappingRule,
  MappingResult,
  Transaction,
  EntityType,
  VatJournalLine,
} from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('mapping-engine')

// Half of prisbasbelopp per year (used for capitalization threshold)
const PRISBASBELOPP_HALVES: Record<number, number> = {
  2024: 28650,  // PBB 57,300
  2025: 29400,  // PBB 58,800
  2026: 29600,  // PBB 59,200
}
const LATEST_KNOWN_YEAR = 2026

function getCapitalizationThreshold(year: number): number {
  const threshold = PRISBASBELOPP_HALVES[year]
  if (threshold) return threshold
  log.warn(`No prisbasbelopp for ${year}, using ${LATEST_KNOWN_YEAR} value`)
  return PRISBASBELOPP_HALVES[LATEST_KNOWN_YEAR]
}

/**
 * Evaluate all mapping rules against a transaction and return the best match
 *
 * Evaluation order (by priority):
 * 1. User override rules (priority 1-49)
 * 2. MCC code rules (priority 50-69)
 * 3. Merchant name pattern rules (priority 70-89)
 * 4. Amount threshold rules (priority 90-99)
 * 5. Counterparty templates (learned from history, fuzzy matching)
 * 6. Static booking templates (keyword/MCC matching)
 * 7. Default fallback (uncategorized)
 */
export async function evaluateMappingRules(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  entityType?: EntityType,
  settlementAccount?: string
): Promise<MappingResult> {
  const bankAccount = settlementAccount || '1930'

  // Pre-step: detect intra-company transfers. When the counterparty IBAN
  // matches another cash_accounts row for the same company, book both legs
  // as a transfer between the two ledger accounts instead of running the
  // priority rules (which would mis-categorize the outflow as an expense).
  try {
    const transfer = await detectOwnAccountTransfer(supabase, companyId, transaction)
    if (transfer) {
      const isFx =
        (transaction.currency || '').toUpperCase() !==
        (transfer.counterCurrency || '').toUpperCase()
      return buildOwnAccountTransferResult(
        transaction,
        bankAccount,
        transfer.counterLedgerAccount,
        isFx,
      )
    }
  } catch (err) {
    // Non-fatal — falling through to normal categorization is correct when
    // the detector fails. We log so an unexpected upstream error is visible.
    log.warn('own-account transfer detection failed', {
      companyId,
      transactionId: transaction.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Fetch all active rules (user-specific + system defaults), ordered by priority
  const { data: rules, error } = await supabase
    .from('mapping_rules')
    .select('*')
    .eq('is_active', true)
    .or(`company_id.eq.${companyId},company_id.is.null`)
    .order('priority', { ascending: true })

  if (error || !rules || rules.length === 0) {
    // Try counterparty templates before static template fallback
    const counterpartyResult = await evaluateCounterpartyTemplates(supabase, companyId, transaction, entityType)
    if (counterpartyResult) return applySettlementAccount(counterpartyResult, bankAccount)

    const templateResult = evaluateTemplateRules(transaction, entityType)
    if (templateResult) return applySettlementAccount(templateResult, bankAccount)
    return getDefaultResult(transaction, bankAccount)
  }

  // Evaluate each rule in priority order
  for (const rule of rules as MappingRule[]) {
    if (matchesRule(rule, transaction)) {
      return applySettlementAccount(buildResult(rule, transaction, entityType), bankAccount)
    }
  }

  // Try counterparty templates before static template fallback
  const counterpartyResult = await evaluateCounterpartyTemplates(supabase, companyId, transaction, entityType)
  if (counterpartyResult) return applySettlementAccount(counterpartyResult, bankAccount)

  // Try template-based matching before default fallback
  const templateResult = evaluateTemplateRules(transaction, entityType)
  if (templateResult) return applySettlementAccount(templateResult, bankAccount)

  return getDefaultResult(transaction, bankAccount)
}

/**
 * Evaluate booking templates as a fallback when no DB mapping rule matches.
 * Returns the best template match if confidence >= 0.3, otherwise null.
 */
function evaluateTemplateRules(
  transaction: Transaction,
  entityType?: EntityType
): MappingResult | null {
  const matches = findMatchingTemplates(transaction, entityType)
  if (matches.length === 0 || matches[0].confidence < 0.3) return null

  const best = matches[0]
  const result = buildMappingResultFromTemplate(
    best.template,
    transaction,
    entityType || 'enskild_firma'
  )
  // Override the confidence with the auto-match confidence (not 1.0)
  result.confidence = best.confidence
  return result
}

/**
 * Evaluate counterparty templates as a fallback when no DB mapping rule matches.
 * Source-aware threshold: auto_learned needs 0.6 (require more evidence),
 * user_approved/sie_import use 0.4 (human has validated the pattern).
 */
async function evaluateCounterpartyTemplates(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  entityType?: EntityType
): Promise<MappingResult | null> {
  try {
    const match = await findCounterpartyTemplate(supabase, companyId, transaction)
    if (!match) return null

    const threshold = match.template.source === 'auto_learned' ? 0.6 : 0.4
    if (match.confidence < threshold) return null

    return buildMappingResultFromCounterpartyTemplate(
      match,
      transaction,
      entityType || 'enskild_firma'
    )
  } catch {
    // Non-critical — fall through to next fallback
    return null
  }
}

/**
 * Check if a transaction matches a mapping rule
 */
function matchesRule(rule: MappingRule, transaction: Transaction): boolean {
  // MCC code matching
  if (rule.mcc_codes && rule.mcc_codes.length > 0) {
    if (!transaction.mcc_code || !rule.mcc_codes.includes(transaction.mcc_code)) {
      return false
    }
  }

  // Merchant name pattern matching (case-insensitive)
  if (rule.merchant_pattern) {
    const merchantName = transaction.merchant_name || transaction.description || ''
    try {
      const regex = new RegExp(rule.merchant_pattern, 'i')
      if (!regex.test(merchantName)) {
        return false
      }
    } catch {
      // Invalid regex, try simple includes
      if (!merchantName.toLowerCase().includes(rule.merchant_pattern.toLowerCase())) {
        return false
      }
    }
  }

  // Description pattern matching
  if (rule.description_pattern) {
    try {
      const regex = new RegExp(rule.description_pattern, 'i')
      if (!regex.test(transaction.description)) {
        return false
      }
    } catch {
      if (!transaction.description.toLowerCase().includes(rule.description_pattern.toLowerCase())) {
        return false
      }
    }
  }

  // Amount threshold matching
  const absAmount = Math.abs(transaction.amount)
  if (rule.amount_min != null && absAmount < rule.amount_min) {
    return false
  }
  if (rule.amount_max != null && absAmount > rule.amount_max) {
    return false
  }

  return true
}

/**
 * Build a MappingResult from a matched rule
 */
function buildResult(rule: MappingRule, transaction: Transaction, entityType?: EntityType): MappingResult {
  const absAmount = Math.abs(transaction.amount)
  const isExpense = transaction.amount < 0

  let debitAccount = rule.debit_account || (isExpense ? '6991' : '1930')
  const creditAccount = rule.credit_account || (isExpense ? '1930' : '3900')

  // Check capitalization threshold for equipment
  const year = new Date(transaction.date).getFullYear()
  const threshold = rule.capitalization_threshold ?? getCapitalizationThreshold(year)
  if (absAmount > threshold && rule.capitalized_debit_account) {
    debitAccount = rule.capitalized_debit_account
  }

  // If default_private, use entity-specific private account
  if (rule.default_private && isExpense) {
    debitAccount = entityType === 'aktiebolag' ? '2893' : '2013'
  }

  // Generate VAT lines if applicable
  const vatLines: VatJournalLine[] = []
  if (isExpense && !rule.default_private && rule.vat_treatment) {
    if (rule.vat_treatment === 'reverse_charge') {
      // Reverse charge: emit BOTH the fiktiv-moms pair (2645/2614) AND the
      // basbelopp pair (44xx|45xx / 4598). The basbelopp pair populates
      // momsdeklaration rutor 20–24; without it Skatteverket rejects with
      // FK004. Mapping rules don't carry supplier-country today, so we
      // default to EU services — the most common reverse-charge scenario.
      const rcRate = 0.25
      const rcLines = generateReverseChargeLines(absAmount, rcRate, false)
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }

      // Skip basbelopp emission if the rule already books to a basis account.
      if (!/^4[45]\d{2}$/.test(debitAccount)) {
        const basisLines = generateReverseChargeBasisLines(absAmount, rcRate, 'eu_business')
        for (const bl of basisLines) {
          vatLines.push({
            account_number: bl.account_number,
            debit_amount: bl.debit_amount,
            credit_amount: bl.credit_amount,
            description: bl.line_description || '',
          })
        }
      }
    } else if (rule.vat_treatment === 'standard_25' || rule.vat_treatment === 'reduced_12' || rule.vat_treatment === 'reduced_6') {
      const vatRate =
        rule.vat_treatment === 'standard_25' ? 0.25
        : rule.vat_treatment === 'reduced_12' ? 0.12
        : 0.06
      const vatLine = generateInputVatLine(absAmount, vatRate)
      if (vatLine) {
        vatLines.push({
          account_number: vatLine.account_number,
          debit_amount: vatLine.debit_amount,
          credit_amount: vatLine.credit_amount,
          description: vatLine.line_description || '',
        })
      }
    }
  }

  return {
    rule,
    debit_account: debitAccount,
    credit_account: creditAccount,
    risk_level: rule.risk_level,
    confidence: rule.confidence_score,
    requires_review: rule.requires_review,
    default_private: rule.default_private,
    vat_lines: vatLines,
    description: rule.rule_name,
  }
}

/**
 * Default result when no rule matches (uncategorized)
 */
function getDefaultResult(transaction: Transaction, bankAccount = '1930'): MappingResult {
  const isExpense = transaction.amount < 0

  return {
    rule: null,
    debit_account: isExpense ? '6991' : bankAccount,
    credit_account: isExpense ? bankAccount : '3900',
    risk_level: 'MEDIUM',
    confidence: 0.1,
    requires_review: true,
    default_private: false,
    vat_lines: [],
    description: 'Obokförd transaktion',
  }
}

/**
 * Build a MappingResult for a detected own-account transfer.
 *
 * For an outflow (negative amount): debit the counter account, credit this
 * side's settlement account. The counter side will book the mirror entry when
 * its row is ingested.
 *
 * For an inflow (positive amount): debit this side's settlement account,
 * credit the counter account.
 *
 * Confidence is high (0.95) because IBAN match against the company's own
 * cash_accounts is an exact identity check, not a heuristic.
 *
 * `isFx` flips `requires_review` to true when the two legs sit on different
 * currencies (e.g. SEK 1930 → EUR 1932). A cross-currency leg generally
 * realises a kursvinst/kursförlust on 3960/7960 (ÅRL 4 kap 10 §) that the
 * two-line transfer entry doesn't capture — a human must confirm the FX gain
 * or loss line rather than auto-booking a potentially incomplete entry.
 * Same-currency transfers stay auto-bookable.
 */
function buildOwnAccountTransferResult(
  transaction: Transaction,
  bankAccount: string,
  counterAccount: string,
  isFx: boolean = false,
): MappingResult {
  const isOutflow = transaction.amount < 0
  return {
    rule: null,
    debit_account: isOutflow ? counterAccount : bankAccount,
    credit_account: isOutflow ? bankAccount : counterAccount,
    risk_level: isFx ? 'MEDIUM' : 'LOW',
    confidence: isFx ? 0.7 : 0.95,
    requires_review: isFx,
    default_private: false,
    vat_lines: [],
    description: isFx
      ? 'Överföring mellan egna konton (FX — granska kursvinst/förlust)'
      : 'Överföring mellan egna konton',
  }
}

/**
 * Replace any default 1930 references in a mapping result with the actual settlement account.
 * This allows mapping rules and templates that don't explicitly set a bank account
 * to work correctly with secondary bank accounts (e.g. 1931).
 */
export function applySettlementAccount(result: MappingResult, bankAccount: string): MappingResult {
  if (bankAccount === '1930') return result
  return {
    ...result,
    debit_account: result.debit_account === '1930' ? bankAccount : result.debit_account,
    credit_account: result.credit_account === '1930' ? bankAccount : result.credit_account,
  }
}

/**
 * Save a user-level mapping rule learned from categorization.
 *
 * When userDescription is provided, the rule gets:
 * - source: 'user_description' (instead of 'auto')
 * - priority: 5 (beats auto-learned at 10)
 * - confidence_score: 0.98
 * - The original user text and template_id stored for UI display
 *
 * User-described rules for the same merchant replace prior user-described rules
 * (latest description wins).
 */
export async function saveUserMappingRule(
  supabase: SupabaseClient,
  companyId: string,
  merchantName: string,
  debitAccount: string,
  creditAccount: string,
  isPrivate: boolean,
  userDescription?: string,
  templateId?: string
): Promise<void> {
  // Escape special regex characters in merchant name
  const escapedMerchant = merchantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  if (userDescription) {
    // Delete existing user_description rule for this merchant (latest wins)
    await supabase
      .from('mapping_rules')
      .delete()
      .eq('company_id', companyId)
      .eq('merchant_pattern', escapedMerchant)
      .eq('source', 'user_description')

    const { error } = await supabase.from('mapping_rules').insert({
      company_id: companyId,
      rule_name: `Described: ${merchantName}`,
      rule_type: 'merchant_name',
      priority: 5,
      merchant_pattern: escapedMerchant,
      debit_account: debitAccount,
      credit_account: creditAccount,
      risk_level: 'NONE',
      default_private: isPrivate,
      requires_review: false,
      confidence_score: 0.98,
      source: 'user_description',
      user_description: userDescription,
      template_id: templateId || null,
    })

    if (error) {
      // Silently fail — saving learned rules is non-critical
    }
  } else {
    const { error } = await supabase.from('mapping_rules').insert({
      company_id: companyId,
      rule_name: `Learned: ${merchantName}`,
      rule_type: 'merchant_name',
      priority: 10,
      merchant_pattern: escapedMerchant,
      debit_account: debitAccount,
      credit_account: creditAccount,
      risk_level: 'NONE',
      default_private: isPrivate,
      requires_review: false,
      confidence_score: 0.95,
      source: 'auto',
    })

    if (error) {
      // Silently fail — saving learned rules is non-critical
    }
  }
}
