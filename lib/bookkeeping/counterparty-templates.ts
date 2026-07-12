import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeMerchantName,
  levenshteinDistance,
} from '@/lib/documents/core-receipt-matcher'
import {
  generateInputVatLine,
  generateReverseChargeLines,
  getVatRate,
} from './vat-entries'
import { dimensionsBagKey } from './dimension-resolver'
import { resolveSekAmount } from './currency-utils'
import { createLogger } from '@/lib/logger'
import type {
  CategorizationTemplate,
  CategorizationTemplateSource,
  EntityType,
  LinePatternEntry,
  MappingResult,
  Transaction,
  VatJournalLine,
  VatTreatment,
} from '@/types'
import type { SIEVoucher } from '@/lib/import/types'

const log = createLogger('counterparty-templates')

// ── Normalization ──────────────────────────────────────────────

/**
 * Month tokens (Swedish + English, abbreviated and full) that show up as a
 * trailing period label on a bank-feed description ("Ngrok Mars", "Spotify
 * januari") rather than as part of the merchant's identity.
 */
const TRAILING_MONTH_TOKENS = new Set([
  'jan', 'feb', 'mar', 'apr', 'maj', 'may', 'jun', 'jul', 'aug', 'sep', 'sept',
  'okt', 'oct', 'nov', 'dec',
  'januari', 'februari', 'mars', 'april', 'juni', 'juli', 'augusti',
  'september', 'oktober', 'november', 'december',
])

/**
 * Strip trailing tokens that label *when/who* rather than *what merchant*:
 * a month name, or a 1-2 letter all-caps personal initial ("ngrok JW",
 * "ngrok JW", "Ngrok Mars" all describe the same merchant). Without this, one
 * merchant splinters into many un-learnable variants and counterparty matching
 * never fires (the reported ngrok bug: three prior bookings, zero matches).
 *
 * Conservative by design: only acts on a TRAILING token, only on 1-2 char
 * all-caps initials (so 3-letter brands like SEB/ICA and any lowercased word
 * survive), and always keeps at least one core token (never strips to empty).
 */
function stripTrailingNoiseTokens(s: string): string {
  const tokens = s.trim().split(/\s+/).filter(Boolean)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    const isMonth = TRAILING_MONTH_TOKENS.has(last.toLowerCase())
    // Personal initials: 1-2 letters, all-caps in the ORIGINAL casing (run
    // before normalizeMerchantName lowercases everything).
    const isInitials = /^[A-ZÅÄÖ]{1,2}$/.test(last)
    if (!isMonth && !isInitials) break
    tokens.pop()
  }
  return tokens.join(' ')
}

/**
 * Normalize a transaction description to a canonical counterparty name.
 *
 * Strips bank transfer prefixes, trailing dates, invoice references, trailing
 * digit sequences, and trailing period/initials tokens, then delegates to
 * normalizeMerchantName() for Swedish company suffix removal and lowercasing.
 */
export function normalizeCounterpartyName(raw: string): string {
  const cleaned = raw
    // Strip common bank transfer prefixes
    .replace(/^(BANKGIRO|SWISH|KORTKÖP|KORT\s*KÖP|PG|BG|AUTOGIRO|PLUSGIRO)\s*/i, '')
    // Strip dates (20240615, 2024-06-15, 24-06-15)
    .replace(/\b\d{2,4}[-/]?\d{2}[-/]?\d{2}\b/g, '')
    // Strip invoice/reference numbers (F2024-001, #12345, INV-123)
    .replace(/\b[F#]?\d{4,}\S*/gi, '')
    .replace(/\bINV[-]?\d+/gi, '')
    // Strip trailing sequences of 4+ digits (card numbers, transaction refs)
    .replace(/\s+\d{4,}\s*$/g, '')
    .trim()

  // Drop trailing month/initials tokens before merchant-name normalization so
  // "ngrok JW" and "Ngrok Mars" collapse to the same canonical "ngrok".
  return normalizeMerchantName(stripTrailingNoiseTokens(cleaned))
}

// ── Confidence ─────────────────────────────────────────────────

// ── Display ───────────────────────────────────────────────────

/** Swedish company suffixes that should be uppercased */
const UPPER_SUFFIXES = new Set(['ab', 'hb', 'kb', 'ek', 'ef', 'uf'])

/**
 * Capitalize a normalized counterparty name for display.
 * "telia sverige ab" → "Telia Sverige AB"
 */
export function formatCounterpartyName(name: string): string {
  return name
    .split(' ')
    .map(w => UPPER_SUFFIXES.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Logarithmic confidence formula.
 * Starts low, grows slowly, caps at 0.95. Early corrections are cheap,
 * later corrections are appropriately alarming.
 */
export function calculateConfidence(occurrenceCount: number): number {
  const raw = 0.3 + Math.log2(occurrenceCount + 1) * 0.15
  return Math.round(Math.min(raw, 0.95) * 100) / 100
}

// ── Source Priority ───────────────────────────────────────────

const SOURCE_PRIORITY: Record<CategorizationTemplateSource, number> = {
  sni_default: 0,
  auto_learned: 1,
  sie_import: 2,
  user_approved: 3,
  // AI-corrected templates carry explicit user validation (they edited the
  // AI's proposal, then confirmed "remember this"), so rank equal to
  // user_approved. Fresh incoming AI corrections still win over older
  // templates of the same rank (>= in resolveSource).
  ai_corrected: 3,
}

export function resolveSource(
  existing: CategorizationTemplateSource,
  incoming: CategorizationTemplateSource
): CategorizationTemplateSource {
  return SOURCE_PRIORITY[incoming] >= SOURCE_PRIORITY[existing] ? incoming : existing
}

// ── Counterparty Template ID Convention ──────────────────────

export const COUNTERPARTY_PREFIX = 'counterparty:'
export function isCounterpartyTemplateId(id: string): boolean { return id.startsWith(COUNTERPARTY_PREFIX) }
export function extractCounterpartyId(id: string): string { return id.slice(COUNTERPARTY_PREFIX.length) }
export function toCounterpartyTemplateId(id: string): string { return COUNTERPARTY_PREFIX + id }

// ── VAT Account Mapping ──────────────────────────────────────

const VAT_ACCOUNT_TREATMENT: Record<string, string> = {
  '2611': 'standard_25',
  '2621': 'reduced_12',
  '2631': 'reduced_6',
  '2641': 'standard_25',
  '2645': 'reverse_charge',
  '2614': 'reverse_charge',
  '2624': 'reverse_charge',
  '2634': 'reverse_charge',
}

/**
 * Reverse-charge/import VAT accounts (fiktiv in-/utgående moms). These net to
 * zero inside a voucher, so SIE pattern extraction must not count them as
 * deductible VAT: doing so poisons the non-VAT base the business ratios are
 * computed against. 2647 = domestic RC input (ML 16 kap); 2615/2625/2635 =
 * output VAT on imports, paired the same way in import vouchers.
 */
const REVERSE_CHARGE_VAT_ACCOUNTS = new Set([
  '2614', '2624', '2634', '2615', '2625', '2635', '2645', '2647',
])

/** Legal Swedish VAT rates a learned pattern is allowed to carry. */
const LEGAL_VAT_RATES = [0.25, 0.12, 0.06]

/** Map a learned VAT rate back to its treatment string. */
function rateToTreatment(rate: number): string | null {
  if (rate === 0.25) return 'standard_25'
  if (rate === 0.12) return 'reduced_12'
  if (rate === 0.06) return 'reduced_6'
  return null
}

/**
 * Livsmedel VAT dropped from 12% to 6% on 2026-04-01 (Prop. 2025/26:55);
 * restaurant/hotel/camping stay at 12%. A 12% template that has not been
 * confirmed since the transition may belong to either group, so its match is
 * review-gated until a post-transition approval refreshes last_seen_date
 * (re-approval keeps 12%, a correction relearns 6%).
 */
const REDUCED_12_TRANSITION_DATE = '2026-04-01'

function isStaleReduced12Match(
  hasReduced12: boolean,
  transactionDate: string,
  lastSeenDate: string | null
): boolean {
  if (!hasReduced12) return false
  // ISO yyyy-mm-dd strings: plain comparison is chronological
  if (transactionDate < REDUCED_12_TRANSITION_DATE) return false
  return !lastSeenDate || lastSeenDate < REDUCED_12_TRANSITION_DATE
}

// ── Lookup ─────────────────────────────────────────────────────

export interface CounterpartyTemplateMatch {
  template: CategorizationTemplate
  matchMethod: 'exact_alias' | 'exact_normalized' | 'fuzzy'
  confidence: number
}

/**
 * Find a counterparty template matching a transaction.
 *
 * Three-tier matching (delegated to batch version with single-element array):
 * 1. Exact alias match
 * 2. Exact normalized name match
 * 3. Fuzzy Levenshtein: distance ≤2 for short names, ≤3 for long names
 */
export async function findCounterpartyTemplate(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction
): Promise<CounterpartyTemplateMatch | null> {
  const results = await findCounterpartyTemplatesBatch(supabase, companyId, [transaction])
  return results.get(transaction.id) ?? null
}

/**
 * Batch counterparty template matching for multiple transactions.
 * One DB query, all matching done in memory.
 */
export async function findCounterpartyTemplatesBatch(
  supabase: SupabaseClient,
  companyId: string,
  transactions: Transaction[]
): Promise<Map<string, CounterpartyTemplateMatch>> {
  const result = new Map<string, CounterpartyTemplateMatch>()

  const { data: allTemplates } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)

  if (!allTemplates || allTemplates.length === 0) return result

  const templates = allTemplates as CategorizationTemplate[]

  // Build alias lookup: lowercase alias → template
  const aliasMap = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    for (const alias of tmpl.counterparty_aliases || []) {
      aliasMap.set(alias, tmpl)
    }
  }

  // Build normalized name lookup
  const nameMap = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    nameMap.set(tmpl.counterparty_name, tmpl)
  }

  for (const tx of transactions) {
    const rawName = tx.merchant_name || tx.description
    if (!rawName) continue

    const normalized = normalizeCounterpartyName(rawName)
    if (!normalized || normalized.length < 2) continue

    // 1. Exact alias match
    const aliasMatch = aliasMap.get(rawName.toLowerCase())
    if (aliasMatch) {
      result.set(tx.id, {
        template: aliasMatch,
        matchMethod: 'exact_alias',
        confidence: Math.min(Number(aliasMatch.confidence) * 1.0, 1),
      })
      continue
    }

    // 2. Exact normalized name match
    const exactMatch = nameMap.get(normalized)
    if (exactMatch) {
      result.set(tx.id, {
        template: exactMatch,
        matchMethod: 'exact_normalized',
        confidence: Math.round(Number(exactMatch.confidence) * 0.95 * 100) / 100,
      })
      continue
    }

    // 3. Fuzzy Levenshtein match
    let bestMatch: CategorizationTemplate | null = null
    let bestDistance = Infinity
    for (const tmpl of templates) {
      const dist = levenshteinDistance(normalized, tmpl.counterparty_name)
      const maxAllowed = normalized.length <= 10 ? 2 : 3
      if (dist <= maxAllowed && dist < bestDistance) {
        bestDistance = dist
        bestMatch = tmpl
      }
    }
    if (bestMatch) {
      const similarity = 1 - bestDistance / Math.max(normalized.length, bestMatch.counterparty_name.length)
      result.set(tx.id, {
        template: bestMatch,
        matchMethod: 'fuzzy',
        confidence: Math.round(Number(bestMatch.confidence) * similarity * 100) / 100,
      })
    }
  }

  return result
}

// ── Build MappingResult ────────────────────────────────────────

/** Which side of a template the money settles on. */
type TemplateDirection = 'expense' | 'income' | 'unknown'

/**
 * Learned direction of a legacy (single debit/credit) template: expenses
 * settle on the credit side (credit bank, debit cost), income settles on the
 * debit side. 'unknown' when neither or both accounts look like settlement.
 */
function legacyTemplateDirection(debitAccount: string, creditAccount: string): TemplateDirection {
  const debitSettles = isSettlementAccount(debitAccount)
  const creditSettles = isSettlementAccount(creditAccount)
  if (creditSettles && !debitSettles) return 'expense'
  if (debitSettles && !creditSettles) return 'income'
  return 'unknown'
}

/** Learned direction of a multi-line pattern: read off the business sides. */
function patternDirection(pattern: LinePatternEntry[]): TemplateDirection {
  const business = pattern.filter((e) => e.type === 'business')
  if (business.length === 0) return 'unknown'
  const debitCount = business.filter((b) => b.side === 'debit').length
  if (debitCount === business.length) return 'expense'
  if (debitCount === 0) return 'income'
  return 'unknown'
}

/**
 * Convert a counterparty template match into a MappingResult
 * (same shape the mapping engine expects).
 *
 * When the transaction's sign contradicts the template's learned direction
 * (an incoming refund matching an expense-learned template, or an outgoing
 * repayment matching an income-learned one), booking the template as-is
 * would post backwards: debit an expense account for money coming IN. Those
 * matches are mirrored instead (settle against the bank, reduce the business
 * account), flagged requires_review, and marked direction_mismatch so they
 * are never learned back into the template.
 */
export function buildMappingResultFromCounterpartyTemplate(
  match: CounterpartyTemplateMatch,
  transaction: Transaction,
  _entityType: EntityType
): MappingResult {
  const tmpl = match.template
  const isExpense = transaction.amount < 0

  // Multi-line pattern path
  if (tmpl.line_pattern && tmpl.line_pattern.length > 0) {
    const learned = patternDirection(tmpl.line_pattern)
    const mirror =
      (learned === 'expense' && !isExpense) || (learned === 'income' && isExpense)
    return buildMultiLineMappingResult(tmpl, match, transaction, mirror)
  }

  // Legacy single debit/credit path.
  // Journal lines are always booked in SEK: compute template amounts from the
  // SEK-resolved amount so foreign-currency transactions stay balanced.
  const absAmount = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))

  const learned = legacyTemplateDirection(tmpl.debit_account, tmpl.credit_account)
  if ((learned === 'expense' && !isExpense) || (learned === 'income' && isExpense)) {
    return buildLegacyMismatchResult(tmpl, match, absAmount, isExpense)
  }

  const vatLines: VatJournalLine[] = []
  if (isExpense && tmpl.vat_treatment) {
    const vatTreatment = tmpl.vat_treatment as VatTreatment
    if (vatTreatment === 'reverse_charge') {
      const rcLines = generateReverseChargeLines(absAmount)
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }
    } else {
      const vatRate = getVatRate(vatTreatment)
      if (vatRate > 0) {
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
  }

  const privateAccounts = ['2013', '2893']
  const isPrivate = privateAccounts.includes(tmpl.debit_account)

  return {
    rule: null,
    debit_account: tmpl.debit_account,
    credit_account: tmpl.credit_account,
    risk_level: 'NONE',
    confidence: match.confidence,
    requires_review: isStaleReduced12Match(
      tmpl.vat_treatment === 'reduced_12', transaction.date, tmpl.last_seen_date
    ),
    default_private: isPrivate,
    vat_lines: vatLines,
    description: `Motpart: ${tmpl.counterparty_name} (${tmpl.occurrence_count} ggr)`,
  }
}

/**
 * Mirrored result for a sign-mismatched legacy template match (see
 * buildMappingResultFromCounterpartyTemplate). Settlement and business
 * accounts swap sides; a refund of an expense also mirrors the VAT legs so
 * the moms follows the correction: deductible input VAT flips to a 2641
 * credit, and a reverse-charge credit note flips both fiktiv legs (credit
 * 2645 / debit 2614) so Ruta 30/48 net back to zero. Income-learned
 * mismatches book gross; the entry is review-gated either way.
 */
function buildLegacyMismatchResult(
  tmpl: CategorizationTemplate,
  match: CounterpartyTemplateMatch,
  absAmount: number,
  isExpense: boolean
): MappingResult {
  const vatLines: VatJournalLine[] = []
  if (!isExpense && tmpl.vat_treatment) {
    if (tmpl.vat_treatment === 'reverse_charge') {
      for (const rcl of generateReverseChargeLines(absAmount)) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.credit_amount,
          credit_amount: rcl.debit_amount,
          description: rcl.line_description || '',
        })
      }
    } else {
      const vatRate = getVatRate(tmpl.vat_treatment as VatTreatment)
      if (vatRate > 0) {
        const vatLine = generateInputVatLine(absAmount, vatRate)
        if (vatLine) {
          vatLines.push({
            account_number: vatLine.account_number,
            debit_amount: 0,
            credit_amount: vatLine.debit_amount,
            description: vatLine.line_description || '',
          })
        }
      }
    }
  }

  return {
    rule: null,
    debit_account: tmpl.credit_account,
    credit_account: tmpl.debit_account,
    risk_level: 'NONE',
    confidence: match.confidence,
    requires_review: true,
    direction_mismatch: true,
    default_private: false,
    vat_lines: vatLines,
    description: `Motpart: ${tmpl.counterparty_name} (retur/återbetalning)`,
  }
}

/**
 * Build a MappingResult from a multi-line counterparty template pattern.
 *
 * VAT is computed from rate (exact), business/tax from ratio against non-VAT subtotal.
 * Rounding difference goes to 3740 (Öresutjämning).
 * Settlement line always equals the exact transaction amount.
 */
function buildMultiLineMappingResult(
  tmpl: CategorizationTemplate,
  match: CounterpartyTemplateMatch,
  transaction: Transaction,
  mirror: boolean = false
): MappingResult {
  const pattern = tmpl.line_pattern!
  // Journal lines are always booked in SEK (see legacy path).
  const absAmount = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))

  // Sign mismatch (refund/repayment): flip every learned side so the mirrored
  // entry reduces what the original pattern built up.
  const side = (s: 'debit' | 'credit'): 'debit' | 'credit' =>
    mirror ? (s === 'debit' ? 'credit' : 'debit') : s

  const allLines: VatJournalLine[] = []

  // 1. Compute VAT lines first (from rate, exact)
  let totalVat = 0
  for (const entry of pattern) {
    if (entry.type === 'vat' && entry.vat_rate) {
      const vatAmount = Math.round(absAmount * entry.vat_rate / (1 + entry.vat_rate) * 100) / 100
      totalVat += vatAmount
      allLines.push({
        account_number: entry.account,
        debit_amount: side(entry.side) === 'debit' ? vatAmount : 0,
        credit_amount: side(entry.side) === 'credit' ? vatAmount : 0,
        description: '',
      })
    }
  }

  // 2. Compute non-VAT subtotal
  const nonVatAmount = Math.round((absAmount - totalVat) * 100) / 100

  // 3. Compute business/tax lines from ratios against nonVatAmount
  let nonVatAllocated = 0
  for (const entry of pattern) {
    if ((entry.type === 'business' || entry.type === 'tax') && entry.ratio !== undefined) {
      const amount = Math.round(nonVatAmount * entry.ratio * 100) / 100
      nonVatAllocated += amount
      allLines.push({
        account_number: entry.account,
        debit_amount: side(entry.side) === 'debit' ? amount : 0,
        credit_amount: side(entry.side) === 'credit' ? amount : 0,
        description: '',
        // Dimensions PR7: business lines carry the pattern's learned bag;
        // VAT/tax/rounding lines stay untagged.
        ...(entry.type === 'business' && entry.dimensions
          ? { dimensions: entry.dimensions }
          : {}),
      })
    }
  }

  // 4. Check for rounding difference → 3740
  const totalAllocated = Math.round((totalVat + nonVatAllocated) * 100) / 100
  const roundingDiff = Math.round((absAmount - totalAllocated) * 100) / 100
  if (roundingDiff !== 0) {
    // Determine the side for the rounding line (same side as business lines)
    const businessSide = side(pattern.find(e => e.type === 'business')?.side ?? 'credit')
    allLines.push({
      account_number: '3740',
      debit_amount: businessSide === 'debit' ? Math.abs(roundingDiff) : 0,
      credit_amount: businessSide === 'credit' ? Math.abs(roundingDiff) : 0,
      description: 'Öresutjämning',
    })
  }

  return {
    rule: null,
    debit_account: mirror ? tmpl.credit_account : tmpl.debit_account,
    credit_account: mirror ? tmpl.debit_account : tmpl.credit_account,
    risk_level: 'NONE',
    confidence: match.confidence,
    requires_review: mirror || isStaleReduced12Match(
      pattern.some(e => e.type === 'vat' && e.vat_rate === 0.12),
      transaction.date,
      tmpl.last_seen_date
    ),
    ...(mirror ? { direction_mismatch: true } : {}),
    default_private: false,
    vat_lines: allLines,
    all_lines_complete: true,
    description: mirror
      ? `Motpart: ${tmpl.counterparty_name} (retur/återbetalning)`
      : `Motpart: ${tmpl.counterparty_name} (${tmpl.occurrence_count} ggr)`,
  }
}

// ── Feedback / Upsert ──────────────────────────────────────────

export interface TemplateUpsertParams {
  counterpartyName: string
  aliases: string[]
  debitAccount: string
  creditAccount: string
  vatTreatment: string | null
  vatAccount: string | null
  category: string | null
  occurrenceCount: number
  confidence: number
  lastSeenDate: string | null
  source: CategorizationTemplateSource
  linePattern?: LinePatternEntry[] | null
}

/**
 * Low-level insert-or-update for a counterparty template.
 *
 * - existingTemplate undefined → DB lookup by (companyId, counterpartyName)
 * - existingTemplate null → skip lookup (batch mode: caller knows none exists)
 * - existingTemplate object → use directly (batch mode: pre-fetched)
 *
 * Re-approval: accumulates occurrence_count, recalculates confidence from total.
 * Correction: uses params.occurrenceCount/confidence, updates accounts. A
 * "correction" whose settlement direction opposes the existing template's
 * (a refund shape against an expense-learned template) is skipped: it is a
 * different kind of event, not a correction, and must never flip the
 * learned accounts.
 * Both paths use resolveSource() so lower-priority sources never overwrite higher.
 *
 * Returns true when a row was actually written. Write failures are logged
 * (learning is non-critical, but it must never fail silently again: the
 * post-refactor NOT NULL mismatch went unnoticed for months because these
 * results were discarded).
 */
export async function insertOrUpdateTemplate(
  supabase: SupabaseClient,
  companyId: string,
  params: TemplateUpsertParams,
  existingTemplate?: CategorizationTemplate | null
): Promise<boolean> {
  // Resolve existing template
  let existing: CategorizationTemplate | null = null
  if (existingTemplate === undefined) {
    const { data } = await supabase
      .from('categorization_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('counterparty_name', params.counterpartyName)
      .maybeSingle()
    existing = data as CategorizationTemplate | null
  } else {
    existing = existingTemplate
  }

  const logContext = {
    companyId,
    counterpartyName: params.counterpartyName,
    source: params.source,
  }

  if (existing) {
    const isCorrection =
      existing.debit_account !== params.debitAccount ||
      existing.credit_account !== params.creditAccount

    // Merge aliases (deduplicated)
    const mergedAliases = [...(existing.counterparty_aliases || [])]
    for (const alias of params.aliases) {
      if (!mergedAliases.includes(alias)) {
        mergedAliases.push(alias)
      }
    }

    const newSource = resolveSource(existing.source, params.source)

    if (isCorrection) {
      // For multi-line templates the legacy fields can both be settlement-ish
      // (direction 'unknown'); fall back to the pattern's business sides so
      // the opposite-direction guard still holds.
      let existingDirection = legacyTemplateDirection(existing.debit_account, existing.credit_account)
      if (existingDirection === 'unknown' && existing.line_pattern && existing.line_pattern.length > 0) {
        existingDirection = patternDirection(existing.line_pattern)
      }
      const incomingDirection = legacyTemplateDirection(params.debitAccount, params.creditAccount)
      if (
        existingDirection !== 'unknown' &&
        incomingDirection !== 'unknown' &&
        existingDirection !== incomingDirection
      ) {
        return false
      }

      const { error } = await supabase
        .from('categorization_templates')
        .update({
          debit_account: params.debitAccount,
          credit_account: params.creditAccount,
          vat_treatment: params.vatTreatment ?? existing.vat_treatment,
          vat_account: params.vatAccount ?? existing.vat_account,
          category: params.category || existing.category,
          occurrence_count: params.occurrenceCount,
          confidence: params.confidence,
          last_seen_date: params.lastSeenDate,
          source: newSource,
          counterparty_aliases: mergedAliases,
          line_pattern: params.linePattern !== undefined ? params.linePattern : existing.line_pattern,
        })
        .eq('id', existing.id)
      if (error) {
        log.error('counterparty template correction failed', { ...logContext, error: error.message })
        return false
      }
    } else {
      // Re-approval: accumulate count, recalculate confidence from total
      const newCount = existing.occurrence_count + params.occurrenceCount
      const newConfidence = calculateConfidence(newCount)

      const { error } = await supabase
        .from('categorization_templates')
        .update({
          occurrence_count: newCount,
          confidence: newConfidence,
          last_seen_date: params.lastSeenDate,
          source: newSource,
          counterparty_aliases: mergedAliases,
          category: params.category || existing.category,
          ...(params.linePattern !== undefined ? { line_pattern: params.linePattern } : {}),
        })
        .eq('id', existing.id)
      if (error) {
        log.error('counterparty template re-approval failed', { ...logContext, error: error.message })
        return false
      }
    }
  } else {
    const { error } = await supabase
      .from('categorization_templates')
      .insert({
        company_id: companyId,
        counterparty_name: params.counterpartyName,
        counterparty_aliases: params.aliases,
        debit_account: params.debitAccount,
        credit_account: params.creditAccount,
        vat_treatment: params.vatTreatment,
        vat_account: params.vatAccount,
        category: params.category,
        line_pattern: params.linePattern ?? null,
        occurrence_count: params.occurrenceCount,
        confidence: params.confidence,
        last_seen_date: params.lastSeenDate,
        source: params.source,
      })
    if (error) {
      log.error('counterparty template insert failed', { ...logContext, error: error.message })
      return false
    }
  }

  return true
}

/**
 * Upsert a counterparty template from a categorization result.
 * Thin wrapper around insertOrUpdateTemplate for single-transaction callers.
 */
export async function upsertCounterpartyTemplate(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  mappingResult: MappingResult,
  source: CategorizationTemplateSource
): Promise<void> {
  // Mirrored refund/repayment bookings must never be learned: they would
  // flip the template's accounts and poison future matches.
  if (mappingResult.direction_mismatch) return

  const rawName = transaction.merchant_name || transaction.description
  if (!rawName) return

  const normalized = normalizeCounterpartyName(rawName)
  if (!normalized || normalized.length < 2) return

  const category = transaction.category !== 'uncategorized' ? transaction.category : null

  await insertOrUpdateTemplate(supabase, companyId, {
    counterpartyName: normalized,
    aliases: [rawName.toLowerCase()],
    debitAccount: mappingResult.debit_account,
    creditAccount: mappingResult.credit_account,
    vatTreatment: mappingResult.vat_lines.length > 0
      ? detectVatTreatment(mappingResult)
      : null,
    vatAccount: mappingResult.vat_lines[0]?.account_number || null,
    category,
    occurrenceCount: 1,
    confidence: calculateConfidence(1),
    lastSeenDate: transaction.date,
    source,
  })
}

/**
 * Detect VAT treatment from a MappingResult's VAT lines.
 */
function detectVatTreatment(result: MappingResult): string | null {
  if (result.vat_lines.length === 0) return null

  // Check for reverse charge (2645 debit = fiktiv ingående)
  const hasReverseCharge = result.vat_lines.some(
    (l) => l.account_number === '2645'
  )
  if (hasReverseCharge) return 'reverse_charge'

  // Check for input VAT (2641 debit)
  const inputVat = result.vat_lines.find(
    (l) => l.account_number === '2641' && l.debit_amount > 0
  )
  if (!inputVat) return null

  // Derive rate from the line description (generated by generateInputVatLine)
  // Format: "Ingående moms 25%", "Ingående moms 12%", "Ingående moms 6%"
  const rateMatch = inputVat.description?.match(/(\d+)%/)
  if (rateMatch) {
    const pct = parseInt(rateMatch[1], 10)
    if (pct === 12) return 'reduced_12'
    if (pct === 6) return 'reduced_6'
  }
  return 'standard_25'
}

// ── SIE Voucher Template Population ──────────────────────────

const SIE_SKIP_DESCRIPTIONS = new Set([
  'lön', 'löner', 'löneutbetalning', 'arbetsgivaravgifter',
  'semesterlöneskuld', 'preliminärskatt', 'momsredovisning', 'moms',
  'bokslutsdisposition', 'bokslut', 'bokslutstransaktion', 'årsbokslut',
  'avskrivning', 'avskrivningar', 'periodisering',
  'upplupna', 'förutbetalda', 'skatteberäkning', 'skattebetalning',
  'resultatdisposition', 'årets resultat',
  'omföring', 'intern omföring', 'korrigering', 'rättelse', 'avslut',
  'öppningsbalans', 'ub', 'ib',
])

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Settlement accounts: bank/cash (19xx), receivables (1510), payables (2440), credit card (2890) */
function isSettlementAccount(account: string): boolean {
  return account.startsWith('19') || account === '1510' || account === '2440' || account === '2890'
}

/** Rounding account: excluded from pattern extraction */
function isRoundingAccount(account: string): boolean {
  return account === '3740'
}

/** Tax/duty accounts in 24xx range (except 2440 = AP settlement) */
function isTaxAccount(account: string): boolean {
  return account.startsWith('24') && account !== '2440'
}

/** Check if a 26xx account is a known VAT account */
function isVatAccount(account: string): boolean {
  return account.startsWith('26') && account in VAT_ACCOUNT_TREATMENT
}

/** Get the VAT rate (decimal) from a VAT account treatment string */
function vatTreatmentToRate(treatment: string): number {
  if (treatment === 'standard_25') return 0.25
  if (treatment === 'reduced_12') return 0.12
  if (treatment === 'reduced_6') return 0.06
  return 0
}

// ── Extracted voucher line pattern ───────────────────────────

interface VoucherLinePattern {
  entries: LinePatternEntry[]
  settlementAccount: string
  settlementSide: 'debit' | 'credit'
  hasReverseCharge: boolean
}

/**
 * Extract a line pattern from a single SIE voucher.
 * Returns null if the voucher can't be represented as a pattern.
 */
function extractVoucherLinePattern(
  lines: { account: string; amount: number; dimensions?: Record<string, string> }[]
): VoucherLinePattern | null {
  type PatternLine = { account: string; amount: number; dimensions?: Record<string, string> }
  const settlement: PatternLine[] = []
  const vat: PatternLine[] = []
  const business: PatternLine[] = []
  let hasReverseCharge = false

  for (const line of lines) {
    if (isSettlementAccount(line.account)) {
      settlement.push(line)
    } else if (isRoundingAccount(line.account)) {
      // Skip 3740 lines: rounding artifacts
      continue
    } else if (REVERSE_CHARGE_VAT_ACCOUNTS.has(line.account)) {
      // Fiktiv moms nets to zero inside the voucher: exclude it from the VAT
      // total (it must not shrink the base the business ratios use) and only
      // remember that the counterparty is reverse-charge.
      hasReverseCharge = true
      continue
    } else if (isVatAccount(line.account)) {
      vat.push(line)
    } else {
      business.push(line)
    }
  }

  // Need at least 1 business account and 1 settlement account
  if (business.length === 0 || settlement.length === 0) return null
  // Skip if too many distinct accounts (likely a complex/manual entry)
  const distinctBusiness = new Set(business.map(l => l.account))
  if (distinctBusiness.size > 5) return null

  const settlementTotal = settlement.reduce((s, l) => s + Math.abs(l.amount), 0)
  if (settlementTotal === 0) return null

  const vatTotal = vat.reduce((s, l) => s + Math.abs(l.amount), 0)
  const nonVatTotal = settlementTotal - vatTotal
  if (nonVatTotal <= 0) return null

  // Determine settlement side from the first settlement line
  const settlementSide: 'debit' | 'credit' = settlement[0].amount >= 0 ? 'debit' : 'credit'

  const entries: LinePatternEntry[] = []

  // VAT lines: store vat_rate, not ratio
  for (const v of vat) {
    let rate: number
    if (v.account === '2641' && vat.length === 1) {
      // 2641 (debiterad ingående moms) is rate-agnostic in BAS: the account
      // alone says nothing about 25/12/6%. Infer the rate from the voucher's
      // own amounts and snap it to a legal rate. If nothing snaps, drop the
      // VAT leg rather than learn a wrong rate. Only safe with a single VAT
      // line: with several, each line's base is unknowable.
      const observed = Math.abs(v.amount) / nonVatTotal
      const snapped = LEGAL_VAT_RATES.find(r => Math.abs(observed - r) <= 0.015)
      if (snapped === undefined) continue
      rate = snapped
    } else {
      const treatment = VAT_ACCOUNT_TREATMENT[v.account]
      if (!treatment) continue
      rate = vatTreatmentToRate(treatment)
      if (rate === 0) continue
    }
    entries.push({
      account: v.account,
      type: 'vat',
      side: v.amount >= 0 ? 'debit' : 'credit',
      vat_rate: rate,
    })
  }

  // Business/tax lines: compute ratio against nonVatTotal
  for (const b of business) {
    const ratio = Math.abs(b.amount) / nonVatTotal
    entries.push({
      account: b.account,
      type: isTaxAccount(b.account) ? 'tax' : 'business',
      side: b.amount >= 0 ? 'debit' : 'credit',
      ratio: Math.round(ratio * 10000) / 10000,
      // Dimensions PR7: carry the source line's bag so SIE-learned templates
      // keep tagging like the history did (dropped in averaging on conflict).
      ...(b.dimensions && Object.keys(b.dimensions).length > 0
        ? { dimensions: b.dimensions }
        : {}),
    })
  }

  return {
    entries,
    settlementAccount: settlement[0].account,
    settlementSide,
    hasReverseCharge,
  }
}

// ── Counterparty group types ─────────────────────────────────

interface CounterpartyGroup {
  normalizedName: string
  aliases: Set<string>
  patterns: Map<string, MultiLinePatternCount>
  totalCount: number
}

interface MultiLinePatternCount {
  accountSet: string  // sorted accounts joined by +
  voucherPatterns: VoucherLinePattern[]  // all individual patterns in this group
  count: number
  latestDate: Date
}

/**
 * Normalize non-VAT ratios in a line pattern to sum to exactly 1.0.
 */
function normalizeRatios(entries: LinePatternEntry[]): LinePatternEntry[] {
  const ratioEntries = entries.filter(e => e.ratio !== undefined)
  if (ratioEntries.length === 0) return entries

  const ratioSum = ratioEntries.reduce((s, e) => s + (e.ratio ?? 0), 0)
  if (ratioSum === 0) return entries

  const result = entries.map(e => {
    if (e.ratio === undefined) return { ...e }
    return { ...e, ratio: Math.round((e.ratio / ratioSum) * 10000) / 10000 }
  })

  // Assign rounding remainder to the largest ratio entry
  const normalizedRatioEntries = result.filter(e => e.ratio !== undefined)
  const newSum = normalizedRatioEntries.reduce((s, e) => s + (e.ratio ?? 0), 0)
  const diff = Math.round((1.0 - newSum) * 10000) / 10000
  if (diff !== 0 && normalizedRatioEntries.length > 0) {
    const largest = normalizedRatioEntries.reduce((a, b) => ((a.ratio ?? 0) >= (b.ratio ?? 0) ? a : b))
    largest.ratio = Math.round(((largest.ratio ?? 0) + diff) * 10000) / 10000
  }

  return result
}

/**
 * Average line patterns from multiple vouchers into a single normalized pattern.
 */
function averageLinePatterns(voucherPatterns: VoucherLinePattern[]): LinePatternEntry[] {
  if (voucherPatterns.length === 0) return []
  if (voucherPatterns.length === 1) return normalizeRatios(voucherPatterns[0].entries)

  // Collect all accounts across all patterns
  const accountMap = new Map<string, {
    type: LinePatternEntry['type']
    side: LinePatternEntry['side']
    ratios: number[]
    vat_rate?: number
    // Dimensions PR7: conservative: a bag survives averaging only when EVERY
    // occurrence of the account carries the identical bag. A single
    // disagreeing (or untagged) voucher drops it: a template must never
    // invent a tag history doesn't consistently support.
    dimensions?: Record<string, string>
    dimensionsConsistent: boolean
  }>()

  for (const vp of voucherPatterns) {
    // Normalize per-voucher ratios before averaging
    const normalized = normalizeRatios(vp.entries)
    for (const entry of normalized) {
      const existing = accountMap.get(entry.account)
      if (!existing) {
        accountMap.set(entry.account, {
          type: entry.type,
          side: entry.side,
          ratios: entry.ratio !== undefined ? [entry.ratio] : [],
          vat_rate: entry.vat_rate,
          dimensions: entry.dimensions,
          dimensionsConsistent: true,
        })
      } else {
        if (entry.ratio !== undefined) {
          existing.ratios.push(entry.ratio)
        }
        if (
          existing.dimensionsConsistent &&
          dimensionsBagKey(existing.dimensions) !== dimensionsBagKey(entry.dimensions)
        ) {
          existing.dimensionsConsistent = false
          existing.dimensions = undefined
        }
      }
    }
  }

  const entries: LinePatternEntry[] = []
  for (const [account, data] of accountMap) {
    const entry: LinePatternEntry = { account, type: data.type, side: data.side }
    if (data.vat_rate !== undefined) {
      entry.vat_rate = data.vat_rate
    }
    if (data.ratios.length > 0) {
      entry.ratio = Math.round((data.ratios.reduce((s, r) => s + r, 0) / data.ratios.length) * 10000) / 10000
    }
    if (data.dimensionsConsistent && data.dimensions && Object.keys(data.dimensions).length > 0) {
      entry.dimensions = data.dimensions
    }
    entries.push(entry)
  }

  return normalizeRatios(entries)
}

/**
 * Analyze SIE voucher history and create counterparty templates.
 *
 * Groups vouchers by normalized description and account set, filters by
 * dominance and minimum occurrences. Supports both simple (single debit/credit)
 * and multi-line patterns (stored as line_pattern JSONB).
 */
export async function populateTemplatesFromSieVouchers(
  supabase: SupabaseClient,
  companyId: string,
  vouchers: SIEVoucher[],
  options?: { recencyMonths?: number }
): Promise<number> {
  if (vouchers.length === 0) return 0

  const recencyMonths = options?.recencyMonths ?? 24

  // Step 0: Recency filter
  let maxDate = vouchers[0].date
  for (const v of vouchers) {
    if (v.date > maxDate) maxDate = v.date
  }
  const cutoff = new Date(maxDate)
  cutoff.setMonth(cutoff.getMonth() - recencyMonths)

  const recentVouchers = vouchers.filter(v => v.date >= cutoff)
  if (recentVouchers.length === 0) return 0

  // Step 1: Build counterparty groups
  const groups = new Map<string, CounterpartyGroup>()

  for (const voucher of recentVouchers) {
    const desc = voucher.description?.trim()
    if (!desc) continue

    const normalized = normalizeCounterpartyName(desc)
    if (!normalized || normalized.length < 2) continue
    if (SIE_SKIP_DESCRIPTIONS.has(normalized)) continue

    // Extract line pattern from voucher
    const linePattern = extractVoucherLinePattern(voucher.lines)
    if (!linePattern) continue

    // Group key: sorted set of non-settlement accounts
    const accountSet = linePattern.entries
      .map(e => e.account)
      .sort()
      .join('+')
    const groupKey = `${normalized}|${accountSet}`

    let group = groups.get(normalized)
    if (!group) {
      group = { normalizedName: normalized, aliases: new Set(), patterns: new Map(), totalCount: 0 }
      groups.set(normalized, group)
    }

    group.aliases.add(desc.toLowerCase())
    group.totalCount += 1

    let pattern = group.patterns.get(groupKey)
    if (!pattern) {
      pattern = { accountSet, voucherPatterns: [], count: 0, latestDate: voucher.date }
      group.patterns.set(groupKey, pattern)
    }
    pattern.voucherPatterns.push(linePattern)
    pattern.count += 1
    if (voucher.date > pattern.latestDate) {
      pattern.latestDate = voucher.date
    }
  }

  // Step 2 & 3: Filter by dominance and compute confidence
  const accepted: {
    normalizedName: string
    aliases: string[]
    pattern: MultiLinePatternCount
    settlementAccount: string
    settlementSide: 'debit' | 'credit'
    confidence: number
  }[] = []

  for (const group of groups.values()) {
    if (group.totalCount < 2) continue

    // Find dominant pattern
    let dominant: MultiLinePatternCount | null = null
    for (const p of group.patterns.values()) {
      if (!dominant || p.count > dominant.count) {
        dominant = p
      }
    }
    if (!dominant) continue

    const dominance = dominant.count / group.totalCount
    if (dominance < 0.6) continue

    const confidence = Math.round(Math.min(0.95, dominance * (1 - 1 / dominant.count)) * 100) / 100

    // Get settlement info from the first voucher pattern
    const firstVp = dominant.voucherPatterns[0]

    accepted.push({
      normalizedName: group.normalizedName,
      aliases: [...group.aliases],
      pattern: dominant,
      settlementAccount: firstVp.settlementAccount,
      settlementSide: firstVp.settlementSide,
      confidence,
    })
  }

  if (accepted.length === 0) return 0

  // Step 4: Batch write
  const { data: existingTemplates } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)

  const templateMap = new Map<string, CategorizationTemplate>()
  if (existingTemplates) {
    for (const t of existingTemplates) {
      templateMap.set(t.counterparty_name, t as CategorizationTemplate)
    }
  }

  let count = 0
  for (const item of accepted) {
    const existing = templateMap.get(item.normalizedName) ?? null

    // Average the line patterns from all vouchers in the dominant group
    const avgPattern = averageLinePatterns(item.pattern.voucherPatterns)

    // Decide: simple (1 business + 0-1 VAT) → legacy fields; otherwise → line_pattern
    const businessEntries = avgPattern.filter(e => e.type === 'business')
    const vatEntries = avgPattern.filter(e => e.type === 'vat')
    const taxEntries = avgPattern.filter(e => e.type === 'tax')
    const isSimple = businessEntries.length === 1 && taxEntries.length === 0 && vatEntries.length <= 1

    // Determine primary business account and settlement for debit/credit fields
    const primaryBusiness = businessEntries.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0]

    let debitAccount: string
    let creditAccount: string
    if (item.settlementSide === 'debit') {
      debitAccount = item.settlementAccount
      creditAccount = primaryBusiness?.account ?? item.settlementAccount
    } else {
      debitAccount = primaryBusiness?.account ?? item.settlementAccount
      creditAccount = item.settlementAccount
    }

    // VAT info from first VAT entry (for legacy fields). The learned rate is
    // authoritative: for 2641 it was inferred from the voucher amounts, so
    // mapping it back through the account table would re-hardcode 25%.
    const firstVat = vatEntries[0]
    let vatAccount = firstVat?.account ?? null
    let vatTreatment = firstVat?.vat_rate !== undefined
      ? rateToTreatment(firstVat.vat_rate)
      : (vatAccount ? (VAT_ACCOUNT_TREATMENT[vatAccount] ?? null) : null)

    // Reverse-charge counterparty (fiktiv moms in every source voucher, no
    // deductible VAT): the simple builder regenerates the RC legs from the
    // treatment, so record it on the legacy fields.
    if (
      isSimple &&
      !vatAccount &&
      item.pattern.voucherPatterns.every(vp => vp.hasReverseCharge)
    ) {
      vatTreatment = 'reverse_charge'
      vatAccount = '2645'
    }

    const written = await insertOrUpdateTemplate(supabase, companyId, {
      counterpartyName: item.normalizedName,
      aliases: item.aliases,
      debitAccount,
      creditAccount,
      vatTreatment,
      vatAccount,
      category: null,
      occurrenceCount: item.pattern.count,
      confidence: item.confidence,
      lastSeenDate: toDateString(item.pattern.latestDate),
      source: 'sie_import',
      linePattern: isSimple ? null : avgPattern,
    }, existing)

    if (written) count += 1
  }

  return count
}
