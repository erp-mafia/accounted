import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeMerchantName,
  levenshteinDistance,
} from '@/lib/documents/core-receipt-matcher'
import {
  generateInputVatLine,
  generateReverseChargePurchaseLines,
  DEFAULT_REVERSE_CHARGE_KIND,
  getVatRate,
  isReverseChargeBasisAccount,
  isReverseChargeVatAccount,
  RC_BASIS_OFFSET_ACCOUNT,
  reverseChargeKindForBasisAccount,
  type ReverseChargeKind,
  type ReverseChargePurchase,
} from './vat-entries'
import {
  isNotVatRegistered,
  vatTreatmentForRegistration,
  type VatRegistration,
} from './vat-registration'
import {
  dimensionsBagKey,
  normalizeLineDimensions,
  validateEntryDimensions,
  type LineDimensions,
} from './dimension-resolver'
import { DimensionValidationError, type DimensionValidationIssue } from './dimension-errors'
import { resolveSekAmount } from './currency-utils'
import { grossVat, treatmentForRate } from '@/lib/bookkeeping/gross-split'
import { stripBankNoise as stripBankMethodPhrases } from './booking-templates'
import { bankSideOf, isMoneyLedger, learnableBankPair, settleBankLeg, type BankSide } from './bank-leg'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { isSkatteverketPayment } from './skatteverket-payment'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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

/**
 * Every active template of the company, paged: one company holds more than
 * PostgREST's 1,000-row page (1,527 in production), and an unpaged read
 * returned an arbitrary 1,000, so a rule past the cut never matched and the
 * SIE learner inserted a duplicate of it into the UNIQUE conflict. Ordered by
 * id so the pages never overlap or skip.
 */
async function fetchActiveTemplates(supabase: SupabaseClient, companyId: string): Promise<CategorizationTemplate[]> {
  return fetchAllRows<CategorizationTemplate>(({ from, to }) =>
    supabase
      .from('categorization_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('id')
      .range(from, to),
  )
}

// ── Normalization ──────────────────────────────────────────────

/**
 * Month tokens (Swedish + English, abbreviated and full) that show up as a
 * trailing period label on a bank-feed description ("Ngrok Mars", "Spotify
 * januari") rather than as part of the merchant's identity.
 */
export const TRAILING_MONTH_TOKENS = new Set([
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
export function stripTrailingNoiseTokens(s: string): string {
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

/** Shared first stage: bank-feed noise that is never merchant identity. */
function stripBankNoise(raw: string): string {
  return raw
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
}

/**
 * Payment processors whose card descriptors put the real merchant AFTER the
 * star ("PAYPAL *SPOTIFY", "SQ *BLUE BOTTLE"). For every other star
 * descriptor the merchant is the segment before it.
 */
const PROCESSOR_STAR_PREFIXES = new Set([
  'paypal', 'klarna', 'izettle', 'zettle', 'iz', 'sq', 'sp', 'sumup',
  'google', 'stripe', 'payu', 'mollie',
])

/**
 * Reduce a card-network descriptor to its merchant segment. Card descriptors
 * embed '*' between merchant identity and a per-charge tail (product, order
 * ref, city): "ANTHROPIC* CLAUDE SUB SAN FRANCISCO" is the merchant
 * "ANTHROPIC", not five words. The tail varies between charges, so keeping it
 * splinters every recurring foreign SaaS subscription into a new counterparty
 * each month. No '*' → returned unchanged.
 *
 * Mirrored in SQL by normalize_counterparty_key(); keep the two in sync
 * (tests/pg/ledger-usage-stats-rpc.pg.test.ts asserts parity).
 */
function extractCardDescriptorCore(cleaned: string): string {
  const starIdx = cleaned.indexOf('*')
  if (starIdx === -1) return cleaned
  const head = cleaned.slice(0, starIdx).trim()
  const tail = cleaned.slice(starIdx + 1).trim()
  const headKey = head.toLowerCase().replace(/[^a-z0-9åäöé]/g, '')
  if (PROCESSOR_STAR_PREFIXES.has(headKey) && tail) return tail
  if (headKey.length >= 3) return head
  return tail || head
}

/**
 * Normalize a transaction description to a canonical counterparty name.
 *
 * Strips bank transfer prefixes, trailing dates, invoice references, trailing
 * digit sequences, card-descriptor tails, and trailing period/initials tokens,
 * then delegates to normalizeMerchantName() for Swedish company suffix removal
 * and lowercasing.
 */
export function normalizeCounterpartyName(raw: string): string {
  const cleaned = extractCardDescriptorCore(stripBankNoise(raw))

  // Drop trailing month/initials tokens before merchant-name normalization so
  // "ngrok JW" and "Ngrok Mars" collapse to the same canonical "ngrok".
  return normalizeMerchantName(stripTrailingNoiseTokens(cleaned))
}

/**
 * Whether a bank descriptor names a counterparty at all. Some lines carry
 * only the bank's payment-method wording and a number: Handelsbanken writes
 * "INTERNET BET 4" on every internet-bank payment, whoever was paid. Such a
 * line is neither learned as a counterparty nor matched against one: a
 * template learned from "INTERNET BET 1" sits one edit away from every other
 * internet payment, so the fuzzy tier offered its account for unrelated
 * suppliers (PostHog PH 118). The phrases are the catalog matcher's list
 * (stripBankNoise in ./booking-templates), not a second one; the persisted
 * key (normalizeCounterpartyName) is untouched.
 */
export function namesCounterparty(raw: string): boolean {
  return /\p{L}/u.test(stripBankMethodPhrases(raw.toLowerCase()))
}

/**
 * Full normalized token set of a descriptor WITHOUT the card-core reduction:
 * the product segment of a card descriptor ("CLAUDE SUB") often carries the
 * very token an existing template is named by ("claude", learned from manual
 * bookings of the same subscription). Feeds the token_subset match tier only;
 * canonical identity stays normalizeCounterpartyName().
 */
export function counterpartyTokenSet(raw: string): Set<string> {
  const full = normalizeMerchantName(stripBankNoise(raw))
  return new Set(full.split(' ').filter(Boolean))
}

/**
 * A billing reference glued onto the name with '-' or '#' that changes with
 * every charge: "Microsoft-G187" one month, "Microsoft-G194" the next,
 * "MICROSOFT#G148769733,MSBILL.INFO". The key keeps it (the hyphen goes, the
 * reference stays: "microsoftg194"), so each month was a new counterpart
 * that never gathered history (crm#1552). One to three letters and at least
 * three digits, so a name like "OK-Q8" keeps its digit.
 */
const GLUED_REFERENCE = /([A-Za-zÅÄÖåäö])[-#][A-Za-z]{1,3}\d{3,}\b/g

/**
 * The counterparty key of a descriptor without its glued billing reference.
 * Matching and learning only: the persisted key (normalizeCounterpartyName,
 * mirrored in SQL) is unchanged, so stored keys and computed ones still agree.
 */
export function referenceFreeKey(raw: string): string {
  return normalizeCounterpartyName(raw.replace(GLUED_REFERENCE, '$1'))
}

/** Whether a descriptor carries a glued billing reference (GLUED_REFERENCE). */
function carriesGluedReference(raw: string): boolean {
  return raw.replace(GLUED_REFERENCE, '$1') !== raw
}

/**
 * Templates by the reference-free key of the bank texts they were learned
 * from (their raw aliases), for aliases that carried a glued reference. Of
 * two templates with one such key (one per month, learned before this
 * fold), the one with the most bookings behind it.
 */
function templatesByReferenceFreeAlias(templates: CategorizationTemplate[]): Map<string, CategorizationTemplate> {
  const byKey = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    for (const alias of tmpl.counterparty_aliases || []) {
      if (!carriesGluedReference(alias)) continue
      const key = referenceFreeKey(alias)
      const held = byKey.get(key)
      if (key.length >= 2 && (!held || tmpl.occurrence_count > held.occurrence_count)) byKey.set(key, tmpl)
    }
  }
  return byKey
}

/**
 * Tokens too generic to identify a merchant on their own: month labels,
 * commerce noise, and geo words that ride along on bank descriptors.
 */
const GENERIC_TOKENS = new Set([
  ...TRAILING_MONTH_TOKENS,
  'subscription', 'subscr', 'abonnemang', 'betalning', 'payment', 'purchase',
  'online', 'store', 'shop', 'butik', 'faktura', 'invoice',
  'sweden', 'sverige', 'stockholm', 'göteborg', 'goteborg', 'malmö', 'malmo',
])

/**
 * What the card rails staple onto every purchase, as the key normalizer
 * leaves it: "Kortköp/uttag" loses its slash and becomes one word, some banks
 * lead with a bare "KORT", and the card's own token ("K8066") rides along.
 * They say HOW the row was paid, and every card row of the company carries
 * them, so they are never evidence of WHO was paid: a template learned from
 * one purchase on a card was offered for every other purchase on that card.
 * The receipt matcher folds the same noise before its own comparison
 * (CARD_VERB and CARD_TOKEN in lib/documents/core-receipt-matcher.ts). A bare
 * "uttag" stays: it can be what the row is ("Eget uttag").
 */
const CARD_RAIL_TOKENS = new Set(['kortköputtag', 'kortkoputtag', 'kortköp', 'kortkop', 'kort'])
const CARD_TOKEN = /^k\d{4}$/

/** A key's words without the card rails' wording: what is left says who was paid. */
function withoutRails(tokens: string[]): string[] {
  return tokens.filter((t) => !CARD_RAIL_TOKENS.has(t) && !CARD_TOKEN.test(t))
}

/**
 * The words that can name a merchant, in the order the line has them: no
 * rails' wording, no generic commerce or place words, no bare numbers.
 */
function nameTokens(tokens: string[]): string[] {
  return withoutRails(tokens).filter((t) => !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t))
}

/** Distinctive = a name word long enough to identify a merchant. */
function distinctiveTokens(name: string[]): string[] {
  return name.filter((t) => t.length >= 4)
}

/**
 * A single shared token is thin evidence: require the template to be backed
 * by real booking history before trusting it, so a template named after a
 * common word or first name (template "anders", occurrence 1) cannot vacuum
 * up unrelated transfers ("SWISH ANDERS JOHANSSON"). Multi-token agreement
 * is specific enough on its own.
 */
const MIN_SINGLE_TOKEN_OCCURRENCES = 3

// ── Confidence ─────────────────────────────────────────────────

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

// ── Display and Counterparty Template ID Convention ──────────

export {
  COUNTERPARTY_PREFIX,
  formatCounterpartyName,
  isCounterpartyTemplateId,
  toCounterpartyTemplateId,
} from './counterparty-template-format'

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
  matchMethod: 'exact_alias' | 'exact_normalized' | 'token_subset' | 'fuzzy'
  confidence: number
}

/**
 * Find a counterparty template matching a transaction.
 *
 * Four-tier matching (delegated to batch version with single-element array):
 * 1. Exact alias match
 * 2. Exact normalized name match
 * 3. Token subset: every distinctive template token appears in the descriptor
 * 4. Fuzzy Levenshtein: distance ≤2 for short names, ≤3 for long names
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

  const allTemplates = await fetchActiveTemplates(supabase, companyId)

  if (allTemplates.length === 0) return result

  // A template learned from a line that names no one ("internet bet 1",
  // stored before namesCounterparty guarded learning) is identity-free: in
  // the token and fuzzy tiers it would claim any descriptor near its words.
  const templates = allTemplates.filter((t) =>
    namesCounterparty(t.counterparty_name),
  )

  // Build alias lookup: lowercase alias → template. An alias that equals
  // another template's canonical counterparty_name (only reachable through a
  // user rename) must not shadow that template when a bank line is exactly
  // that string: the canonical owner wins.
  const canonicalOwner = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    canonicalOwner.set(tmpl.counterparty_name, tmpl)
  }
  const aliasMap = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    for (const alias of tmpl.counterparty_aliases || []) {
      const owner = canonicalOwner.get(alias)
      if (owner && owner.id !== tmpl.id) continue
      aliasMap.set(alias, tmpl)
    }
  }

  // Build normalized name lookup. A user rename (PATCH
  // /api/settings/counterparty-templates) moves the bank-derived key into
  // counterparty_aliases; without the alias leg here, a template renamed to a
  // human label ("musik") would keep learning through findTemplateByKey but
  // never be proposed again, since the alias tier above only sees raw
  // descriptors. A booking on a template of a row whose key it lacked puts
  // that key here too (upsertCounterpartyTemplate), so an abbreviated bank
  // text a person tied to the template matches it by name from then on.
  // A real counterparty_name always wins over an alias.
  const nameMap = new Map<string, CategorizationTemplate>()
  for (const tmpl of templates) {
    nameMap.set(tmpl.counterparty_name, tmpl)
  }
  for (const tmpl of templates) {
    for (const alias of tmpl.counterparty_aliases || []) {
      if (!nameMap.has(alias)) nameMap.set(alias, tmpl)
    }
  }
  const referenceFreeAliasMap = templatesByReferenceFreeAlias(templates)

  // Each key split once for the token and fuzzy tiers below.
  const keyed = templates.map((tmpl) => {
    const tokens = tmpl.counterparty_name.split(' ')
    const name = nameTokens(tokens)
    return { tmpl, tokens, bare: withoutRails(tokens).join(' '), name, distinct: distinctiveTokens(name) }
  })

  for (const tx of transactions) {
    // Identity anchors on the immutable bank original, not the working title:
    // the ingest boundary strips the trailing channel phrase off description
    // ("SPOTIFY AB Kortköp" → "SPOTIFY AB") and users can rename it, but
    // templates were learned from the full bank string, so matching the
    // original keeps every era's keys and aliases aligned (same rationale as
    // buildMerchantHistory in lib/transactions/category-suggestions.ts).
    const rawName = tx.merchant_name || tx.original_description || tx.description
    if (!rawName || !namesCounterparty(rawName)) continue

    // A payment to Skatteverket books on the skattekonto by rule
    // (leadWithSkattekonto in lib/transactions/propose.ts); a template
    // learned from one, right or wrong, is never offered for it (crm#1275).
    if (isSkatteverketPayment(tx)) continue

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

    // 2. Exact normalized name match, also once a glued billing reference is
    // gone on either side: "Microsoft-G194" is the template learned from
    // "Microsoft AB" or from "Microsoft-G187" (crm#1552).
    const referenceFree = referenceFreeKey(rawName)
    const exactMatch =
      nameMap.get(normalized) ?? nameMap.get(referenceFree) ?? referenceFreeAliasMap.get(referenceFree)
    if (exactMatch) {
      result.set(tx.id, {
        template: exactMatch,
        matchMethod: 'exact_normalized',
        confidence: Math.round(Number(exactMatch.confidence) * 0.95 * 100) / 100,
      })
      continue
    }

    // 3. Token-subset match. Bridges the gaps exact and Levenshtein tiers
    // cannot: a template learned from manual bookings ("claude") whose token
    // appears inside a card descriptor ("ANTHROPIC* CLAUDE SUB SAN
    // FRANCISCO"), and a card-core descriptor ("anthropic") contained in a
    // template learned from the full splintered string before card-core
    // normalization existed. These differ by whole words, not typos.
    //
    // One of the two has to find its own first name word in the other. A
    // line and a learned key both lead with who was paid, and what follows
    // (a product, a city) is shared by strangers: "BUN MEE SAN FRANCISCO"
    // matched a software vendor on the city alone, its own name being all
    // short words. And a key that is the same name once the rails' wording
    // is gone is the same counterpart on another card, with or without
    // booking history behind it.
    const txTokens = counterpartyTokenSet(rawName)
    const coreTokens = normalized.split(' ')
    const coreBare = withoutRails(coreTokens).join(' ')
    const coreName = nameTokens(coreTokens)
    const coreDistinct = distinctiveTokens(coreName)
    let tokenBest: CategorizationTemplate | null = null
    let tokenBestShared = 0
    for (const { tmpl, tokens: tmplTokens, bare: tmplBare, name: tmplName, distinct: tmplDistinct } of keyed) {
      const sameName = coreName.length > 0 && coreBare === tmplBare
      const leadShared =
        (coreName.length > 0 && tmplTokens.includes(coreName[0])) ||
        (tmplName.length > 0 && txTokens.has(tmplName[0]))
      const templateInTx =
        leadShared &&
        tmplDistinct.length > 0 &&
        tmplDistinct.every((t) => txTokens.has(t)) &&
        (tmplDistinct.length >= 2 || tmpl.occurrence_count >= MIN_SINGLE_TOKEN_OCCURRENCES)
      const coreInTemplate =
        leadShared &&
        coreDistinct.length > 0 &&
        coreDistinct.every((t) => tmplTokens.includes(t)) &&
        (coreDistinct.length >= 2 || tmpl.occurrence_count >= MIN_SINGLE_TOKEN_OCCURRENCES)
      if (!sameName && !templateInTx && !coreInTemplate) continue
      const shared = sameName ? Infinity : templateInTx ? tmplDistinct.length : coreDistinct.length
      if (
        shared > tokenBestShared ||
        (shared === tokenBestShared &&
          tokenBest !== null &&
          tmpl.occurrence_count > tokenBest.occurrence_count)
      ) {
        tokenBestShared = shared
        tokenBest = tmpl
      }
    }
    if (tokenBest) {
      result.set(tx.id, {
        template: tokenBest,
        matchMethod: 'token_subset',
        confidence: Math.round(Number(tokenBest.confidence) * 0.85 * 100) / 100,
      })
      continue
    }

    // 4. Fuzzy Levenshtein match, on the names without the rails' wording:
    // a shared tail ("k1631 kortköputtag") is longer than most names and put
    // any two short ones within three edits of each other.
    let bestMatch: CategorizationTemplate | null = null
    let bestDistance = Infinity
    let bestLength = 0
    for (const { tmpl, bare: tmplBare } of keyed) {
      if (!coreBare || !tmplBare) continue
      const dist = levenshteinDistance(coreBare, tmplBare)
      const maxAllowed = coreBare.length <= 10 ? 2 : 3
      if (dist <= maxAllowed && dist < bestDistance) {
        bestDistance = dist
        bestMatch = tmpl
        bestLength = tmplBare.length
      }
    }
    if (bestMatch) {
      const similarity = 1 - bestDistance / Math.max(coreBare.length, bestLength)
      result.set(tx.id, {
        template: bestMatch,
        matchMethod: 'fuzzy',
        confidence: Math.round(Number(bestMatch.confidence) * similarity * 100) / 100,
      })
    }
  }

  // Every consumer of a match applies its learned bags (the proposals and
  // their Bokför, the mapping engine, suggestions), so the codes the
  // registry no longer accepts are dropped here, once, for the matched
  // templates only.
  const matched = [...new Map([...result.values()].map((m) => [m.template.id, m.template])).values()]
  const pruned = new Map(
    (await pruneLearnedTemplateDimensions(supabase, companyId, matched)).map((t) => [t.id, t]),
  )
  for (const [txId, match] of result) {
    const template = pruned.get(match.template.id)
    if (template && template !== match.template) result.set(txId, { ...match, template })
  }

  return result
}

/**
 * A template picked by id (the categorize doors' counterparty_template_id) as
 * a match, its learned bags pruned like every other read that applies them.
 * Null when the id is not an active template of the company.
 */
export async function loadCounterpartyTemplateMatch(
  supabase: SupabaseClient,
  companyId: string,
  templateId: string,
): Promise<CounterpartyTemplateMatch | null> {
  const { data } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('id', templateId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()
  if (!data) return null
  const [template] = await pruneLearnedTemplateDimensions(supabase, companyId, [data as CategorizationTemplate])
  return { template, matchMethod: 'exact_alias', confidence: Number(template.confidence) }
}

/**
 * The templates without the learned dimension codes the registry no longer
 * accepts. A learned bag (default_dimensions, a line-pattern entry's bag) is
 * a suggestion, not a user decision: once its value is archived, or its
 * dimension or value is gone, applying it would turn the next booking of a
 * company with dimensions enabled into a DimensionValidationError. Such
 * codes are dropped with a structured warning; active codes stay.
 *
 * "Not accepted" is exactly what the engine rejects: the bags go through
 * validateEntryDimensions itself (toggle gate, registry, fail-open), so the
 * two can never disagree. Explicit picks never pass through here and are
 * still rejected when archived. No bag, no query; nothing dropped, the same
 * objects back.
 */
export async function pruneLearnedTemplateDimensions(
  supabase: SupabaseClient,
  companyId: string,
  templates: CategorizationTemplate[],
): Promise<CategorizationTemplate[]> {
  const hasCodes = (bag: LineDimensions | null | undefined): bag is LineDimensions =>
    !!bag && Object.keys(bag).length > 0
  const bags = templates.flatMap((t) => [
    t.default_dimensions,
    ...(t.line_pattern ?? []).map((entry) => entry.dimensions),
  ]).filter(hasCodes)
  if (bags.length === 0) return templates

  let issues: DimensionValidationIssue[]
  try {
    await validateEntryDimensions(supabase, companyId, bags.map((dimensions) => ({ dimensions })))
    return templates
  } catch (err) {
    if (!(err instanceof DimensionValidationError)) {
      // Same posture as the engine's own check: a failed lookup never blocks
      // a booking, and the engine validates the bag again anyway.
      log.warn('learned dimension check failed, bags kept', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      return templates
    }
    issues = err.issues
  }

  const reasonFor = (dimNo: string, code: string): DimensionValidationIssue['reason'] | null =>
    issues.find((i) => i.sie_dim_no === dimNo && (i.code === null || i.code === code))?.reason ?? null

  return templates.map((template) => {
    const dropped: DimensionValidationIssue[] = []
    const prune = <T extends LineDimensions | undefined>(bag: T): T | LineDimensions => {
      if (!hasCodes(bag)) return bag
      const kept: LineDimensions = {}
      let changed = false
      for (const [dimNo, code] of Object.entries(normalizeLineDimensions({ dimensions: bag }))) {
        const reason = reasonFor(dimNo, code)
        if (reason) {
          dropped.push({ sie_dim_no: dimNo, code, reason })
          changed = true
        } else {
          kept[dimNo] = code
        }
      }
      return changed ? kept : bag
    }

    const defaultDimensions = prune(template.default_dimensions)
    const linePattern = template.line_pattern?.map((entry) => {
      const dimensions = prune(entry.dimensions)
      if (dimensions === entry.dimensions) return entry
      const { dimensions: _stale, ...rest } = entry
      return hasCodes(dimensions) ? { ...rest, dimensions } : rest
    })
    if (dropped.length === 0) return template

    log.warn('learned dimension codes dropped: no longer active in the registry', {
      companyId,
      templateId: template.id,
      dropped,
    })
    return {
      ...template,
      default_dimensions: defaultDimensions,
      line_pattern: linePattern ?? template.line_pattern,
    }
  })
}

// ── Build MappingResult ────────────────────────────────────────

/** Which side of a template the money settles on. */
export type TemplateDirection = 'expense' | 'income' | 'unknown'

/**
 * Learned direction of a legacy (single debit/credit) template: expenses
 * settle on the credit side (credit bank, debit cost), income settles on the
 * debit side. 'unknown' when neither or both accounts look like settlement.
 */
export function legacyTemplateDirection(
  debitAccount: string,
  creditAccount: string,
  /** The company's card ledgers, which settle like 2890 does. */
  moneyLedgers: readonly string[] = [],
): TemplateDirection {

  const debitSettles = isSettlementAccount(debitAccount, moneyLedgers)
  const creditSettles = isSettlementAccount(creditAccount, moneyLedgers)
  if (creditSettles && !debitSettles) return 'expense'
  if (debitSettles && !creditSettles) return 'income'
  return 'unknown'
}

/**
 * A reverse-charge basis pair inside a learned line pattern: the basis leg
 * (4531, 4535, 4515 and so on; ruta 20-24) and its offset (4598, or a
 * company's own 4599) on opposite sides with the same ratio, beside the cost
 * lines. SIE learning keeps both legs as business lines, since the basis
 * account is what tells EU from non-EU, and drops the fiktiv moms. Shared out
 * like cost lines they shrank every real line to a fraction of the purchase
 * and left the entry unbalanced, so a replay books them apart
 * (patternReverseChargeLines).
 */
export interface PatternReverseChargePair {
  basis: LinePatternEntry
  offset: LinePatternEntry
  kind: ReverseChargeKind
  rate: number
}

/** What a replay shares the payment over, and the basis pair it books apart. */
export interface PatternReplayPlan {
  /** The VAT, business and tax entries of the pattern, without the basis pair. */
  entries: LinePatternEntry[]
  /** Scales each business/tax ratio so the remaining ones sum to one again; 1 without a pair. */
  ratioScale: number
  rcPair: PatternReverseChargePair | null
}

export function patternReplayPlan(pattern: readonly LinePatternEntry[]): PatternReplayPlan {
  for (const basis of pattern) {
    const basisRatio = basis.ratio
    if (basis.type !== 'business' || basisRatio === undefined) continue
    const kindAndRate = reverseChargeKindForBasisAccount(basis.account)
    if (!kindAndRate) continue
    const offset = pattern.find((e) =>
      e !== basis &&
      e.type === 'business' &&
      e.side !== basis.side &&
      e.ratio !== undefined &&
      Math.abs(e.ratio - basisRatio) <= 0.0002 &&
      // 4598 (BAS) or a company's own 4599; no basis account ends in 9x.
      /^4[45]9\d$/.test(e.account),
    )
    if (!offset) continue
    const entries = pattern.filter((e) => e !== basis && e !== offset)
    const shared = entries
      .filter((e) => e.type === 'business' || e.type === 'tax')
      .reduce((sum, e) => sum + (e.ratio ?? 0), 0)
    // A pair with no cost line beside it has nothing to book the payment on.
    if (shared <= 0) break
    return { entries, ratioScale: 1 / shared, rcPair: { basis, offset, ...kindAndRate } }
  }
  return { entries: [...pattern], ratioScale: 1, rcPair: null }
}

/**
 * The complete reverse-charge set a pattern's basis pair stands for: fiktiv
 * moms on 2645 (2647 for domestic) and 2614, 2624 or 2634 (rutor 48 and 30-32)
 * plus the basis pair on the learned basis and offset accounts (ruta 20-24),
 * all from generateReverseChargePurchaseLines. `purchases` is the pair's
 * purchase at its learned rate and kind on the replay's non-VAT amount, as the
 * replay books it, or that purchase settled on the pattern's cost lines
 * (reverseChargePurchasesOn), as the proposal preview shows it. Oriented like
 * the learned basis leg, so a pattern learned from a credit note reverses it;
 * a caller's mirror applies on top.
 */
export function patternReverseChargeLines(
  pair: PatternReverseChargePair,
  purchases: readonly ReverseChargePurchase[],
): { account: string; side: 'debit' | 'credit'; amount: number; description: string }[] {
  const asLearned = pair.basis.side === 'debit'
  return purchases.flatMap(generateReverseChargePurchaseLines).map((line) => {
    const isDebit = line.debit_amount > 0
    return {
      account: line.account_number === RC_BASIS_OFFSET_ACCOUNT ? pair.offset.account : line.account_number,
      side: isDebit === asLearned ? 'debit' : 'credit',
      amount: isDebit ? line.debit_amount : line.credit_amount,
      description: line.line_description || '',
    }
  })
}

/** Learned direction of a multi-line pattern: read off the business sides. */
export function patternDirection(pattern: LinePatternEntry[]): TemplateDirection {
  // A reverse-charge basis pair has a leg on each side; the cost lines beside
  // it carry the direction.
  const business = patternReplayPlan(pattern).entries.filter((e) => e.type === 'business')
  if (business.length === 0) return 'unknown'
  const debitCount = business.filter((b) => b.side === 'debit').length
  if (debitCount === business.length) return 'expense'
  if (debitCount === 0) return 'income'
  return 'unknown'
}

/**
 * The side of a learned template that holds its bank leg when it is replayed
 * on a transaction of this sign: what buildMappingResultFromCounterpartyTemplate
 * books on the bank side, read off the stored pair before any mirroring. An
 * expense-learned template settled on its credit account and an
 * income-learned one on its debit account, also when a refund mirrors it; a
 * template of unknown direction (a transfer between two cash ledgers) is not
 * mirrored, so its bank leg follows the transaction's sign.
 */
function templateBankSide(
  tmpl: CategorizationTemplate,
  transactionAmount: number,
  moneyLedgers: readonly string[] = [],
): BankSide {
  const learned = tmpl.line_pattern && tmpl.line_pattern.length > 0
    ? patternDirection(tmpl.line_pattern)
    : legacyTemplateDirection(tmpl.debit_account, tmpl.credit_account, moneyLedgers)
  if (learned === 'expense') return 'credit'
  if (learned === 'income') return 'debit'
  return bankSideOf(transactionAmount)
}

/**
 * A learned template as it books on this transaction: its bank leg on the
 * transaction's own settlement ledger instead of the cash ledger it happened
 * to be learned on (crm#1046: a card fee learned on the GBP account, offered
 * on the EUR one). The same rewrite applySettlementAccount makes at booking
 * (settleBankLeg), so a proposal shows the accounts the verifikat will carry.
 */
export function bindTemplateToSettlementAccount(
  tmpl: CategorizationTemplate,
  transactionAmount: number,
  settlementAccount: string,
  /** The company's card ledgers (bank-leg.ts): a bank leg on one moves too. */
  moneyLedgers: readonly string[] = [],
): CategorizationTemplate {
  return settleBankLeg(tmpl, templateBankSide(tmpl, transactionAmount, moneyLedgers), settlementAccount, moneyLedgers)
}

/**
 * The reverse-charge lines a legacy (single-pair) template replays: the
 * complete set from generateReverseChargePurchaseLines, so a learned
 * reverse-charge counterparty books the basis pair (ruta 20-24) too. The
 * template stores no supplier country, so the basis lands on EU services
 * (the mapping-rule default). A template whose business account reports the
 * basis itself (a basis account, or an account with a reverse-charge momskod)
 * loses the pair, and takes that account's momssats, when the booking door
 * settles it with the chart (reconcileRcBasisWithChart).
 */
function learnedReverseChargeLines(absAmount: number) {
  return generateReverseChargePurchaseLines({
    base: absAmount,
    kind: DEFAULT_REVERSE_CHARGE_KIND,
  })
}

/** The basis accounts (ruta 20-24) among reverse-charge lines, as one comparable key. */
function rcBasisKey(lines: readonly { account_number: string }[]): string {
  return lines.map((l) => l.account_number).filter(isReverseChargeBasisAccount).sort().join(',')
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
  _entityType: EntityType,
  vatRegistered?: VatRegistration
): MappingResult {
  const tmpl = match.template
  const isExpense = transaction.amount < 0

  // Multi-line pattern path
  if (tmpl.line_pattern && tmpl.line_pattern.length > 0) {
    const learned = patternDirection(tmpl.line_pattern)
    const mirror =
      (learned === 'expense' && !isExpense) || (learned === 'income' && isExpense)
    return buildMultiLineMappingResult(tmpl, match, transaction, mirror, vatRegistered)
  }

  // Legacy single debit/credit path.
  // Journal lines are always booked in SEK: compute template amounts from the
  // SEK-resolved amount so foreign-currency transactions stay balanced.
  const absAmount = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))

  // The learned treatment resolved for the company's VAT registration: a
  // pattern learned while the company booked 2641 it could never reclaim
  // must not keep doing so (lib/bookkeeping/vat-registration.ts).
  const vatTreatment = vatTreatmentForRegistration(
    tmpl.vat_treatment as VatTreatment | null, vatRegistered,
  )

  const learned = legacyTemplateDirection(tmpl.debit_account, tmpl.credit_account)
  if ((learned === 'expense' && !isExpense) || (learned === 'income' && isExpense)) {
    return buildLegacyMismatchResult(tmpl, match, absAmount, isExpense, vatTreatment)
  }

  const vatLines: VatJournalLine[] = []
  if (isExpense && vatTreatment) {
    if (vatTreatment === 'reverse_charge') {
      for (const rcl of learnedReverseChargeLines(absAmount)) {
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
    // Learned bag tags the business line (buildTransactionEntryLines); an
    // explicitly supplied bag on the categorize call overwrites it afterwards.
    ...(tmpl.default_dimensions && Object.keys(tmpl.default_dimensions).length > 0
      ? { dimensions: tmpl.default_dimensions }
      : {}),
    description: `Motpart: ${tmpl.counterparty_name} (${tmpl.occurrence_count} ggr)`,
  }
}

/**
 * Mirrored result for a sign-mismatched legacy template match (see
 * buildMappingResultFromCounterpartyTemplate). Settlement and business
 * accounts swap sides; a refund of an expense also mirrors the VAT legs so
 * the moms follows the correction: deductible input VAT flips to a 2641
 * credit, and a reverse-charge credit note flips both fiktiv legs (credit
 * 2645 / debit 2614) and the basis pair (credit 45xx / debit 4598) so Ruta
 * 20-24, 30 and 48 net back to zero. Income-learned
 * mismatches book gross; the entry is review-gated either way.
 */
function buildLegacyMismatchResult(
  tmpl: CategorizationTemplate,
  match: CounterpartyTemplateMatch,
  absAmount: number,
  isExpense: boolean,
  /** tmpl.vat_treatment resolved for the company's VAT registration. */
  vatTreatment: VatTreatment | null
): MappingResult {
  const vatLines: VatJournalLine[] = []
  if (!isExpense && vatTreatment) {
    if (vatTreatment === 'reverse_charge') {
      // Both pairs flip, so the refund also takes the basis back out of
      // ruta 20-24, not only the moms out of ruta 30/48.
      for (const rcl of learnedReverseChargeLines(absAmount)) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.credit_amount,
          credit_amount: rcl.debit_amount,
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
    // A refund of a tagged expense reduces the same kostnadsställe/projekt,
    // mirroring how the multi-line path keeps entry bags when mirrored.
    ...(tmpl.default_dimensions && Object.keys(tmpl.default_dimensions).length > 0
      ? { dimensions: tmpl.default_dimensions }
      : {}),
    description: `Motpart: ${tmpl.counterparty_name} (retur/återbetalning)`,
  }
}

/**
 * Build a MappingResult from a multi-line counterparty template pattern.
 *
 * VAT is computed from rate (exact), business/tax from ratio against non-VAT subtotal.
 * Rounding difference goes to 3740 (Öresutjämning): on the business side when
 * the ratios under-allocate, on the opposite side when they over-allocate (#1898).
 * A reverse-charge basis pair is not shared out: the cost lines take the
 * payment and the complete reverse-charge set is booked on it
 * (patternReplayPlan). Settlement line always equals the exact transaction amount.
 */
function buildMultiLineMappingResult(
  tmpl: CategorizationTemplate,
  match: CounterpartyTemplateMatch,
  transaction: Transaction,
  mirror: boolean = false,
  vatRegistered?: VatRegistration
): MappingResult {
  const pattern = tmpl.line_pattern!
  const plan = patternReplayPlan(pattern)
  // Journal lines are always booked in SEK (see legacy path).
  const absAmount = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))

  // Sign mismatch (refund/repayment): flip every learned side so the mirrored
  // entry reduces what the original pattern built up.
  const side = (s: 'debit' | 'credit'): 'debit' | 'credit' =>
    mirror ? (s === 'debit' ? 'credit' : 'debit') : s

  // A non-registered company keeps no deductible or output VAT line from the
  // learned pattern; the business ratios then allocate the full amount.
  // Reverse-charge legs stay: self-assessment is a separate obligation from
  // deduction (lib/bookkeeping/vat-registration.ts).
  const keepsVatEntry = (account: string): boolean =>
    !isNotVatRegistered(vatRegistered) || isReverseChargeVatAccount(account)

  const allLines: VatJournalLine[] = []

  // 1. Compute VAT lines first (from rate, exact)
  let totalVat = 0
  for (const entry of plan.entries) {
    if (entry.type === 'vat' && entry.vat_rate && keepsVatEntry(entry.account)) {
      const vatAmount = grossVat(absAmount, entry.vat_rate)
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
  for (const entry of plan.entries) {
    if ((entry.type === 'business' || entry.type === 'tax') && entry.ratio !== undefined) {
      const amount = Math.round(nonVatAmount * entry.ratio * plan.ratioScale * 100) / 100
      nonVatAllocated += amount
      allLines.push({
        account_number: entry.account,
        debit_amount: side(entry.side) === 'debit' ? amount : 0,
        credit_amount: side(entry.side) === 'credit' ? amount : 0,
        description: '',
        // Dimensions PR7: business lines carry the pattern's learned bag;
        // VAT/tax/rounding lines stay untagged. The marker is what lets an
        // explicit categorize bag tag the same lines, and only them
        // (buildTransactionEntryLines).
        ...(entry.type === 'business' ? { business_line: true } : {}),
        ...(entry.type === 'business' && entry.dimensions
          ? { dimensions: entry.dimensions }
          : {}),
      })
    }
  }

  // 3b. The reverse-charge set on the purchase, in place of the learned pair.
  // It nets to zero, so it plays no part in the rounding below.
  if (plan.rcPair) {
    const purchase = { base: nonVatAmount, rate: plan.rcPair.rate, kind: plan.rcPair.kind }
    for (const line of patternReverseChargeLines(plan.rcPair, [purchase])) {
      allLines.push({
        account_number: line.account,
        debit_amount: side(line.side) === 'debit' ? line.amount : 0,
        credit_amount: side(line.side) === 'credit' ? line.amount : 0,
        description: line.description,
      })
    }
  }

  // 4. Check for rounding difference → 3740
  const totalAllocated = Math.round((totalVat + nonVatAllocated) * 100) / 100
  const roundingDiff = Math.round((absAmount - totalAllocated) * 100) / 100
  if (roundingDiff !== 0) {
    // A positive diff means the ratios under-allocated: 3740 fills the gap on
    // the business side. A negative diff means they over-allocated (three
    // 0.3334 ratios on 100.00 kr give 3 x 33.34 = 100.02): 3740 offsets on
    // the OPPOSITE side so the non-settlement lines net to absAmount (#1898).
    // businessSide is already mirror-applied via side(), so flip after it.
    const businessSide = side(plan.entries.find(e => e.type === 'business')?.side ?? 'credit')
    const roundingSide: 'debit' | 'credit' =
      roundingDiff > 0 ? businessSide : (businessSide === 'debit' ? 'credit' : 'debit')
    allLines.push({
      account_number: '3740',
      debit_amount: roundingSide === 'debit' ? Math.abs(roundingDiff) : 0,
      credit_amount: roundingSide === 'credit' ? Math.abs(roundingDiff) : 0,
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
  /**
   * Bag {sie_dim_no: code} from the booking being learned. Latest-explicit-
   * wins: a non-empty bag replaces the stored default_dimensions, an empty/
   * omitted bag leaves it untouched (an untagged booking is not evidence the
   * user stopped tagging this counterparty).
   */
  defaultDimensions?: Record<string, string> | null
}

/**
 * Find the template that owns a learned key: by counterparty_name first,
 * then by alias. A user rename moves the old key into counterparty_aliases
 * (PATCH /api/settings/counterparty-templates), so the alias leg is what
 * keeps re-approvals landing on the renamed row instead of inserting a
 * second template under the bank-derived name.
 */
async function findTemplateByKey(
  supabase: SupabaseClient,
  companyId: string,
  counterpartyName: string
): Promise<CategorizationTemplate | null> {
  const { data: byName } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('counterparty_name', counterpartyName)
    .maybeSingle()
  if (byName) return byName as CategorizationTemplate

  const { data: byAlias } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .contains('counterparty_aliases', [counterpartyName])
    .order('occurrence_count', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (byAlias as CategorizationTemplate | null) ?? null
}

/**
 * The template a row with a glued billing reference belongs to: the one
 * keyed by the reference-free name ("microsoft", learned from "Microsoft
 * AB"), else the one learned from the same name with another reference, as
 * the matcher finds it (templatesByReferenceFreeAlias).
 */
async function findTemplateByReferenceFreeKey(
  supabase: SupabaseClient,
  companyId: string,
  referenceFree: string,
): Promise<CategorizationTemplate | null> {
  if (referenceFree.length < 2) return null
  const byKey = await findTemplateByKey(supabase, companyId, referenceFree)
  if (byKey) return byKey
  const templates = await fetchActiveTemplates(supabase, companyId)
  return templatesByReferenceFreeAlias(templates).get(referenceFree) ?? null
}

/**
 * Whether a booking teaches the same pair the template already holds. Which
 * of the company's cash ledgers the money settled on is a fact of the
 * transaction, not of the counterparty (applySettlementAccount books the bank
 * leg on the transaction's own ledger whatever the template stores), so a
 * pair that differs only in that bank leg is a re-approval. Counted as a
 * correction, every booking on another of the company's accounts reset the
 * template's occurrence count and flipped its stored ledger back and forth
 * (crm#1046). A pair of unknown direction (a transfer between two cash
 * ledgers) is compared as stored: both legs are what it learned. A company
 * card's ledger (moneyLedgers) is a bank leg like a 19xx one, so a pair
 * stored with the card's 2890 and one learned with the 1930 placeholder are
 * the same counterparty habit.
 */
export function samePairButBankLedger(
  existing: Pick<CategorizationTemplate, 'debit_account' | 'credit_account'>,
  debitAccount: string,
  creditAccount: string,
  moneyLedgers: readonly string[] = [],
): boolean {
  if (existing.debit_account === debitAccount && existing.credit_account === creditAccount) return true
  const money = (account: string) => isMoneyLedger(account, moneyLedgers)
  const direction = legacyTemplateDirection(debitAccount, creditAccount, moneyLedgers)
  if (direction === 'expense') {
    return existing.debit_account === debitAccount && money(existing.credit_account) && money(creditAccount)
  }
  if (direction === 'income') {
    return existing.credit_account === creditAccount && money(existing.debit_account) && money(debitAccount)
  }
  return false
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
  existingTemplate?: CategorizationTemplate | null,
  /** The booked row's card ledger, when it was a card row (bank-leg.ts). */
  moneyLedgers: readonly string[] = [],
): Promise<boolean> {
  // Resolve existing template
  let existing: CategorizationTemplate | null = null
  if (existingTemplate === undefined) {
    existing = await findTemplateByKey(supabase, companyId, params.counterpartyName)
  } else {
    existing = existingTemplate
  }

  const logContext = {
    companyId,
    counterpartyName: params.counterpartyName,
    source: params.source,
  }

  if (existing) {
    const isCorrection = !samePairButBankLedger(existing, params.debitAccount, params.creditAccount, moneyLedgers)

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
          // The booking's own moms, none included: null means the corrected
          // pair books no moms, not "unknown". Falling back to the old value
          // kept 25 % on a pair moved from a cost to 1630 or 2440 (crm#1275).
          vat_treatment: params.vatTreatment,
          vat_account: params.vatAccount,
          category: params.category || existing.category,
          occurrence_count: params.occurrenceCount,
          confidence: params.confidence,
          last_seen_date: params.lastSeenDate,
          source: newSource,
          counterparty_aliases: mergedAliases,
          // Rules ladder: a changed proposal is a correction the Regler page
          // shows next to the hit count (migration 20260907121500).
          corrections: (existing.corrections ?? 0) + 1,
          line_pattern: params.linePattern !== undefined ? params.linePattern : existing.line_pattern,
          ...(params.defaultDimensions && Object.keys(params.defaultDimensions).length > 0
            ? { default_dimensions: params.defaultDimensions }
            : {}),
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
          ...(params.defaultDimensions && Object.keys(params.defaultDimensions).length > 0
            ? { default_dimensions: params.defaultDimensions }
            : {}),
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
        default_dimensions: params.defaultDimensions ?? {},
        occurrence_count: params.occurrenceCount,
        confidence: params.confidence,
        last_seen_date: params.lastSeenDate,
        source: params.source,
      })
    if (error) {
      // 23505 on (company_id, counterparty_name): a parallel booking of the
      // same counterpart (a batch books five rows at once) inserted it
      // between the lookup above and this insert. The row is there now, so
      // this approval counts on it like any re-approval.
      if (error.code === '23505') {
        const raced = await findTemplateByKey(supabase, companyId, params.counterpartyName)
        if (raced) return insertOrUpdateTemplate(supabase, companyId, params, raced, moneyLedgers)
      }
      log.error('counterparty template insert failed', { ...logContext, error: error.message })
      return false
    }
  }

  return true
}

/**
 * The counterpart template a booking was made on, when the booking named one
 * (the categorize doors' counterparty_template_id, approved by a person).
 */
export interface UpsertCounterpartyOptions {
  bookedOnTemplateId?: string | null
}

/**
 * The template a booking named by id, for alias learning: active and of the
 * company, or null.
 */
async function bookedOnTemplate(
  supabase: SupabaseClient,
  companyId: string,
  templateId: string,
): Promise<CategorizationTemplate | null> {
  const { data } = await supabase
    .from('categorization_templates')
    .select('*')
    .eq('id', templateId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()
  return (data as CategorizationTemplate | null) ?? null
}

/**
 * Upsert a counterparty template from a categorization result.
 * Thin wrapper around insertOrUpdateTemplate for single-transaction callers.
 *
 * A row booked on a counterpart template whose own key no template holds
 * teaches that template its text (accounted#36). The bank often abbreviates
 * a party ("CBA PLESK" for a template learned from "Levfakt Cleverbridge -
 * Plesk"), so the two share no first name word and the token tier cannot
 * tie them without the false matches !243 removed. The booking is the
 * evidence: the row's normalized key joins the template's aliases, and the
 * next row with that text is the same name (exact_normalized). Without this
 * the booking started a second template under the row's key, with one
 * booking behind it, splitting the counterpart's history. Only a booking
 * that took the template's own accounts teaches it; one that booked
 * otherwise learns under the row's own key, as before, and leaves the
 * template alone.
 */
export async function upsertCounterpartyTemplate(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  mappingResult: MappingResult,
  source: CategorizationTemplateSource,
  options: UpsertCounterpartyOptions = {},
): Promise<void> {
  // Mirrored refund/repayment bookings must never be learned: they would
  // flip the template's accounts and poison future matches.
  if (mappingResult.direction_mismatch) return

  // A payment to Skatteverket is booked on the skattekonto by rule
  // (isSkatteverketPayment), never by habit: learned, one mistaken booking
  // became the next proposal for every later payment (crm#1275). The matcher
  // skips these lines too.
  if (isSkatteverketPayment(transaction)) return

  // A learned pair keeps only 'reverse_charge' and replays it through
  // learnedReverseChargeLines (EU services, 25 %). A purchase that replay would
  // book with another basis, such as 4531 for a supplier outside the EU, would
  // come back in the wrong ruta, so it teaches nothing: the catalog template or
  // a saved rule keeps proposing it (crm#1028). A booking with no basis pair
  // at all had a cost account that reports ruta 20-24 itself
  // (reconcileRcBasisWithChart dropped the pair), and a replay on the same
  // account is settled the same way, so that one is learned.
  const bookedBasis = rcBasisKey(mappingResult.vat_lines)
  if (
    detectVatTreatment(mappingResult) === 'reverse_charge' &&
    bookedBasis !== '' &&
    bookedBasis !== rcBasisKey(learnedReverseChargeLines(100))
  ) {
    return
  }

  // Learn from the immutable bank original (see findCounterpartyTemplatesBatch):
  // learning and lookup MUST derive the key from the same string, or the
  // ingest-time phrase strip would fork template identities by era.
  const rawName =
    transaction.merchant_name || transaction.original_description || transaction.description
  // A line that names no one ("INTERNET BET 4") teaches nothing about a
  // counterparty: the matcher skips it too (namesCounterparty).
  if (!rawName || !namesCounterparty(rawName)) return

  const normalized = normalizeCounterpartyName(rawName)
  if (!normalized || normalized.length < 2) return

  const category = transaction.category !== 'uncategorized' ? transaction.category : null

  // A card row's booking is learned with the bank placeholder on its bank
  // leg (learnableBankPair), so it replays as K 1930 on a bank row and as the
  // card's ledger on the card's next row (settleBankLeg).
  const learned = learnableBankPair(mappingResult, transaction.amount)
  const bookedBankLeg = transaction.amount < 0 ? mappingResult.credit_account : mappingResult.debit_account
  const moneyLedgers = learned === mappingResult || !isCardLedgerAccount(bookedBankLeg) ? [] : [bookedBankLeg]

  let existing = await findTemplateByKey(supabase, companyId, normalized)
  const aliases = [rawName.toLowerCase()]
  // A row whose only difference is its glued billing reference is the same
  // counterpart (referenceFreeKey): its key joins that template's aliases
  // instead of starting a new template each month (crm#1552).
  if (!existing && carriesGluedReference(rawName)) {
    existing = await findTemplateByReferenceFreeKey(supabase, companyId, referenceFreeKey(rawName))
    if (existing) aliases.unshift(normalized)
  }
  if (!existing && options.bookedOnTemplateId) {
    const chosen = await bookedOnTemplate(supabase, companyId, options.bookedOnTemplateId)
    if (chosen && samePairButBankLedger(chosen, learned.debit_account, learned.credit_account, moneyLedgers)) {
      existing = chosen
      aliases.unshift(normalized)
    }
  }

  await insertOrUpdateTemplate(supabase, companyId, {
    counterpartyName: normalized,
    aliases,
    debitAccount: learned.debit_account,
    creditAccount: learned.credit_account,
    vatTreatment: mappingResult.vat_lines.length > 0
      ? detectVatTreatment(mappingResult)
      : null,
    vatAccount: mappingResult.vat_lines[0]?.account_number || null,
    category,
    occurrenceCount: 1,
    confidence: calculateConfidence(1),
    lastSeenDate: transaction.date,
    source,
    // The bag the booking actually carried (user-picked or template-applied).
    // Latest-explicit-wins inside insertOrUpdateTemplate: empty bags never
    // erase a learned one.
    defaultDimensions: mappingResult.dimensions ?? null,
  }, existing, moneyLedgers)
}

export type UnlearnOutcome = 'decremented' | 'deactivated'

/**
 * Take back what a bank booking taught when its verifikat is reversed
 * (lib/bookkeeping/handlers/unlearn-on-reversal.ts). The verifikat was the
 * evidence for one occurrence of its pair; left in place, a booking undone
 * two seconds later stayed a learned habit and came back as the row's
 * proposal two days later (crm#1275).
 *
 * The template is found the way upsertCounterpartyTemplate found it (the same
 * key from the same bank text), and only a template whose pair the verifikat
 * carries is touched: a booking on other accounts never taught it. One
 * occurrence comes off; a template left with none is switched off, the same
 * write as "Ta bort mall". A correction cannot be rolled back (the pair it
 * replaced is not kept): it reset the count to one, so reversing it switches
 * the template off. A rule the person set to book on its own ('auto') is
 * their instruction, not a habit, and is left alone.
 */
export async function unlearnCounterpartyTemplate(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Pick<Transaction, 'merchant_name' | 'original_description' | 'description'>,
  lines: ReadonlyArray<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>,
): Promise<UnlearnOutcome | null> {
  const rawName = transaction.merchant_name || transaction.original_description || transaction.description
  if (!rawName || !namesCounterparty(rawName)) return null
  const normalized = normalizeCounterpartyName(rawName)
  if (!normalized || normalized.length < 2) return null

  const template = await findTemplateByKey(supabase, companyId, normalized)
  if (!template || !template.is_active || template.mode === 'auto') return null
  if (!verifikatCarriesPair(template, lines)) return null

  const remaining = (Number(template.occurrence_count) || 0) - 1
  const outcome: UnlearnOutcome = remaining >= 1 ? 'decremented' : 'deactivated'
  const { error } = outcome === 'decremented'
    ? await supabase
      .from('categorization_templates')
      .update({ occurrence_count: remaining, confidence: calculateConfidence(remaining) })
      .eq('id', template.id)
      .eq('company_id', companyId)
    : await supabase
      .from('categorization_templates')
      .update({ is_active: false })
      .eq('id', template.id)
      .eq('company_id', companyId)
  if (error) {
    log.error('counterparty template unlearn failed', { companyId, templateId: template.id, error: error.message })
    return null
  }
  return outcome
}

/**
 * Whether a verifikat books the template's pair the way a booking that
 * taught it would: the business leg on its side (the bank leg may sit on any
 * of the company's ledgers, as samePairButBankLedger allows). A pair of
 * unknown direction must appear as stored.
 */
function verifikatCarriesPair(
  template: Pick<CategorizationTemplate, 'debit_account' | 'credit_account'>,
  lines: ReadonlyArray<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>,
): boolean {
  const debits = (account: string) => lines.some((l) => l.account_number === account && Number(l.debit_amount) > 0)
  const credits = (account: string) => lines.some((l) => l.account_number === account && Number(l.credit_amount) > 0)
  const direction = legacyTemplateDirection(template.debit_account, template.credit_account)
  if (direction === 'expense') return debits(template.debit_account)
  if (direction === 'income') return credits(template.credit_account)
  return debits(template.debit_account) && credits(template.credit_account)
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

/**
 * Settlement accounts: bank/cash (19xx), receivables (1510), payables (2440),
 * credit card (2890), and the company's own card ledgers when the caller
 * knows them (moneyLedgers: a card on 2899 or 2480 settles like 2890).
 */
export function isSettlementAccount(account: string, moneyLedgers: readonly string[] = []): boolean {

  return account.startsWith('19') || account === '1510' || account === '2440' || account === '2890' ||
    moneyLedgers.includes(account)
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
  const existingTemplates = await fetchActiveTemplates(supabase, companyId)

  // Keyed by counterparty_name, then by alias: a renamed template keeps its
  // old bank-derived key as an alias (see findTemplateByKey), and a SIE
  // re-import must update that row rather than insert a duplicate.
  const templateMap = new Map<string, CategorizationTemplate>()
  for (const t of existingTemplates) {
    templateMap.set(t.counterparty_name, t)
  }
  for (const t of existingTemplates) {
    for (const alias of t.counterparty_aliases || []) {
      if (!templateMap.has(alias)) templateMap.set(alias, t)
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
      ? treatmentForRate(firstVat.vat_rate)
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
