import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeMerchantName,
  levenshteinDistance,
} from '@/lib/documents/core-receipt-matcher'
import {
  bankRowVatLines,
  generateReverseChargePurchaseLines,
  DEFAULT_REVERSE_CHARGE_KIND,
  isImportBasisAccount,
  isReverseChargeBasisAccount,
  isReverseChargeVatAccount,
  outputVatTreatmentOfAccount,
  RC_BASIS_OFFSET_ACCOUNT,
  reverseChargeKindForBasisAccount,
  reverseChargePurchasesOn,
  resolveReverseChargeRate,
  vatAccountNature,
  type ReverseChargeKind,
  type ReverseChargePurchase,
} from './vat-entries'
import {
  isNotVatRegistered,
  isRateBearing,
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
import { roundOre } from '@/lib/money'
import { grossVat, rateOfStatedVat, treatmentForRate } from '@/lib/bookkeeping/gross-split'
import { stripBankNoise as stripBankMethodPhrases } from './booking-templates'
import { bankSideOf, isMoneyLedger, learnableBankPair, settleBankLeg, type BankSide } from './bank-leg'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { isSkatteverketPayment } from './skatteverket-payment'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { TRANSACTION_FALLBACK_DESCRIPTION } from '@/types'
import type {
  CategorizationTemplate,
  CategorizationTemplateSource,
  EntityType,
  LinePatternEntry,
  MappingResult,
  TemplateVatTreatment,
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
 *
 * Nor does the title a row is stored with when the bank sent no text at all
 * (TRANSACTION_FALLBACK_DESCRIPTION, "Okänd transaktion"): every such row
 * carries it, whoever was paid, so one booking of it was proposed for all
 * of them. A template already learned under it (its key is the same text)
 * is skipped by the matcher like any other key that names no one.
 */
export function namesCounterparty(raw: string): boolean {
  if (raw.trim().toLowerCase() === TRANSACTION_FALLBACK_DESCRIPTION.toLowerCase()) return false
  return /\p{L}/u.test(stripBankMethodPhrases(raw.toLowerCase()))
}

/**
 * Whether a mapping rule's merchant pattern names a counterparty
 * (namesCounterparty). A learned rule (saveUserMappingRule) stores the row's
 * merchant text as an escaped regex literal, so the pattern is read back as
 * text first. A rule learned from a text that only says how the money moved
 * ("INSÄTTNING", "KORTKÖP", "BG-BETALNING") is about no one: it booked every
 * later row with that text on the first row's accounts, a share capital
 * deposit and a card payout alike (crm#1707).
 */
export function mappingPatternNamesCounterparty(pattern: string): boolean {
  return namesCounterparty(mappingPatternText(pattern))
}

/** A learned rule's merchant pattern (an escaped regex literal) read back as the text it was learned from. */
export function mappingPatternText(pattern: string): string {
  return pattern.replace(/\\(.)/g, '$1')
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

/**
 * What a template stores for moms its bookings carried that is no one
 * Swedish rate of the net: part of the purchase without moms or at another
 * rate (a mixed invoice). Never stored as none: the deductible moms would be
 * dropped on every replay. See hasUnknownVat.
 */
export const UNKNOWN_VAT = 'unknown' as const satisfies TemplateVatTreatment

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
  const allTemplates = await fetchActiveTemplates(supabase, companyId)
  const result = matchCounterpartyTemplates(allTemplates, transactions)
  if (allTemplates.length === 0) return result

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
 * The bank rows a counterparty rule the company has switched off (paused, or
 * removed: is_active false) would match, by the tiers an active rule is
 * matched by. The row's proposals take nothing from such a rule; a reader
 * that would otherwise propose from the counterparty's history asks here, so
 * a switched-off rule silences that proposal too.
 */
export async function findSwitchedOffCounterpartyRules(
  supabase: SupabaseClient,
  companyId: string,
  transactions: Transaction[],
): Promise<Set<string>> {
  const switchedOff = await fetchAllRows<CategorizationTemplate>(({ from, to }) =>
    supabase
      .from('categorization_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', false)
      .order('id')
      .range(from, to),
  )
  return new Set(matchCounterpartyTemplates(switchedOff, transactions).keys())
}

/** A counterparty rule the company switched off, as a learned mapping row beside it is read against it. */
export type SwitchedOffCounterpartyRule = Pick<CategorizationTemplate, 'debit_account' | 'credit_account'>

/**
 * The company's switched-off counterparty rules by the names they answer to:
 * each one's key and aliases, trimmed and lowercased. A pause in Regler and a
 * rule the system took back (an undone first booking, a cleanup) are the same
 * write: is_active false, which categorization_templates_sync_mode shows as
 * paused. Read by mappingRulesBesideSwitchedOff (./mapping-engine.ts). Throws
 * when the read fails.
 */
export async function readSwitchedOffRulesByName(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, SwitchedOffCounterpartyRule[]>> {
  const rows = await fetchAllRows<
    Pick<CategorizationTemplate, 'id' | 'counterparty_name' | 'counterparty_aliases' | 'debit_account' | 'credit_account'>
  >(({ from, to }) =>
    supabase
      .from('categorization_templates')
      .select('id, counterparty_name, counterparty_aliases, debit_account, credit_account')
      .eq('company_id', companyId)
      .eq('is_active', false)
      .order('id')
      .range(from, to),
  )
  const byName = new Map<string, SwitchedOffCounterpartyRule[]>()
  for (const row of rows) {
    const rule = { debit_account: row.debit_account, credit_account: row.credit_account }
    const names = new Set([row.counterparty_name, ...(row.counterparty_aliases ?? [])].map((name) => name?.trim().toLowerCase()))
    for (const name of names) if (name) byName.set(name, [...(byName.get(name) ?? []), rule])
  }
  return byName
}

/**
 * The four match tiers over templates already read: no query, no pruning of
 * learned bags. A row that matches none has no entry.
 */
function matchCounterpartyTemplates(
  allTemplates: CategorizationTemplate[],
  transactions: Transaction[],
): Map<string, CounterpartyTemplateMatch> {
  const result = new Map<string, CounterpartyTemplateMatch>()

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
  /**
   * Scales each business/tax ratio so the remaining ones net to one again: 1
   * for a one-sided pattern without a pair.
   */
  ratioScale: number
  rcPair: PatternReverseChargePair | null
  /**
   * The side the business and tax lines net on when they sit on both sides
   * (twoSidedNet), null for a one-sided pattern.
   */
  netSide: 'debit' | 'credit' | null
}

/**
 * The net of a pattern's business and tax ratios when they sit on both
 * sides. Ratios are stored normalized over every line whichever side it is on
 * (normalizeRatios), so a pattern with an offsetting pair beside its cost,
 * such as tjänstepension on 7412 with its särskild löneskatt on 7533 against
 * 2514, shared the payment over the pair too: replayed at those ratios the
 * pension took two thirds of the payment and the entry did not balance. The
 * payment is what the larger side covers beyond the other, so a replay scales
 * by that net (crm#1746). null for a one-sided pattern, which replays exactly
 * as before.
 */
function twoSidedNet(entries: readonly LinePatternEntry[]): { net: number; side: 'debit' | 'credit' } | null {
  let debit = 0
  let credit = 0
  for (const e of entries) {
    if ((e.type !== 'business' && e.type !== 'tax') || e.ratio === undefined) continue
    if (e.side === 'debit') debit += e.ratio
    else credit += e.ratio
  }
  if (debit === 0 || credit === 0) return null
  return debit >= credit ? { net: debit - credit, side: 'debit' } : { net: credit - debit, side: 'credit' }
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
    const twoSided = twoSidedNet(entries)
    const shared = twoSided
      ? twoSided.net
      : entries
        .filter((e) => e.type === 'business' || e.type === 'tax')
        .reduce((sum, e) => sum + (e.ratio ?? 0), 0)
    // A pair with no cost line beside it has nothing to book the payment on.
    if (shared <= 0) break
    return { entries, ratioScale: 1 / shared, rcPair: { basis, offset, ...kindAndRate }, netSide: twoSided?.side ?? null }
  }
  const twoSided = twoSidedNet(pattern)
  // Lines that cancel out entirely book nothing for the payment: left as stored.
  if (twoSided && twoSided.net > 0) {
    return { entries: [...pattern], ratioScale: 1 / twoSided.net, rcPair: null, netSide: twoSided.side }
  }
  return { entries: [...pattern], ratioScale: 1, rcPair: null, netSide: null }
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
 * The reverse-charge lines a legacy (single-pair) template replays
 * (learnedPairVatLines, through bankRowVatLines with no kind): the complete
 * set from generateReverseChargePurchaseLines, so a learned reverse-charge
 * counterparty books the basis pair (ruta 20-24) too. The template stores no
 * supplier country, so the basis lands on EU services (the mapping-rule
 * default). A template whose business account reports the basis itself (a
 * basis account, or an account with a reverse-charge momskod) loses the pair,
 * and takes that account's momssats, when the booking door settles it with
 * the chart (reconcileRcBasisWithChart).
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
 * Whether a transaction of this sign runs against the template's learned
 * direction: money in on an expense-learned template (a supplier's refund or
 * credit) or money out on an income-learned one (a customer refunded). The
 * one decision: the booking mirrors such a match
 * (buildMappingResultFromCounterpartyTemplate), and the row's proposal, the
 * review policy and the MCP suggestion tool say so before it is booked
 * (crm#1598).
 */
export function contradictsLearnedDirection(
  tmpl: Pick<CategorizationTemplate, 'debit_account' | 'credit_account' | 'line_pattern'>,
  transactionAmount: number,
): boolean {
  const learned = tmpl.line_pattern && tmpl.line_pattern.length > 0
    ? patternDirection(tmpl.line_pattern)
    : legacyTemplateDirection(tmpl.debit_account, tmpl.credit_account)
  const isExpense = transactionAmount < 0
  return (learned === 'expense' && !isExpense) || (learned === 'income' && isExpense)
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
  const mirror = contradictsLearnedDirection(tmpl, transaction.amount)

  // Multi-line pattern path
  if (tmpl.line_pattern && tmpl.line_pattern.length > 0) {
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
  const vatTreatment = vatTreatmentForRegistration(tmpl.vat_treatment, vatRegistered)

  const vatLines = learnedPairVatLines(tmpl.vat_account, vatTreatment, absAmount, isExpense, mirror)

  if (mirror) {
    return buildLegacyMismatchResult(tmpl, match, vatLines)
  }

  const privateAccounts = ['2013', '2893']
  const isPrivate = privateAccounts.includes(tmpl.debit_account)

  return {
    rule: null,
    debit_account: tmpl.debit_account,
    credit_account: tmpl.credit_account,
    risk_level: 'NONE',
    confidence: match.confidence,
    // Unknown moms books none of its own (bankRowVatLines has no rate for
    // it): the underlag's moms is stated in the review (hasUnknownVat).
    requires_review: reviewsUnknownVat(tmpl, vatRegistered) || isStaleReduced12Match(
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
 * The moms a learned single pair books on this row: the lines a category or
 * a catalog template books for the same row (bankRowVatLines), so a bank row
 * books the same moms whichever of the three decided it.
 *
 * What the moms is comes from the pair, not from the row's sign. The moms
 * account the pair was learned with (vat_account) says whether its booking
 * carried utgående moms (26x1: a sale) or ingående moms (2641: a purchase),
 * and money running against that is the reversal of it, taken back on the
 * same account. Before, only money out got a moms line, always 2641: a pair
 * learned from Swish sales (D 1930 / K 3001 / K 2611) booked every later sale
 * gross on 3001 with no 2611 (crm#1632), and a pair learned from refunds to
 * customers (D 3001 / D 2611 / K 1930) booked their moms as ingående. A pair
 * learned with no moms account takes the side of its learned direction.
 *
 * Reverse charge is the buyer's self-assessment of a purchase and replays as
 * it always has: the whole set on money out in the learned direction, the set
 * reversed on a mirrored refund, nothing otherwise.
 */
function learnedPairVatLines(
  vatAccount: string | null,
  /** tmpl.vat_treatment resolved for the company's VAT registration; unknown moms has no rate and books none. */
  vatTreatment: TemplateVatTreatment | null,
  absAmount: number,
  isExpense: boolean,
  mirror: boolean,
): VatJournalLine[] {
  // Money out in the learned direction, or money in mirrored against it.
  const learnedPurchase = isExpense !== mirror
  if (vatTreatment === 'reverse_charge') {
    return learnedPurchase
      ? bankRowVatLines({ treatment: vatTreatment, absSek: absAmount, nature: 'expense', reversal: mirror })
      : []
  }
  const nature = vatAccountNature(vatAccount) ?? (learnedPurchase ? 'expense' : 'income')
  return bankRowVatLines({
    treatment: vatTreatment,
    absSek: absAmount,
    nature,
    reversal: (nature === 'expense') !== isExpense,
  })
}

/**
 * Mirrored result for a sign-mismatched legacy template match (see
 * buildMappingResultFromCounterpartyTemplate). Settlement and business
 * accounts swap sides, and the moms follows the correction
 * (learnedPairVatLines): a refund of a purchase credits 2641, a refund to a
 * customer debits the 26x1 its sale credited, and a reverse-charge credit
 * note flips both fiktiv legs (credit 2645 / debit 2614) and the basis pair
 * (credit 45xx / debit 4598) so Ruta 20-24, 30 and 48 net back to zero. The
 * entry is review-gated either way.
 */
function buildLegacyMismatchResult(
  tmpl: CategorizationTemplate,
  match: CounterpartyTemplateMatch,
  vatLines: VatJournalLine[],
): MappingResult {
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
      // On a two-sided pattern a line against the net side offsets the
      // others: the lines net to the payment (twoSidedNet).
      nonVatAllocated += plan.netSide && entry.side !== plan.netSide ? -amount : amount
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
    const businessSide = side(plan.netSide ?? plan.entries.find(e => e.type === 'business')?.side ?? 'credit')
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
    // A moms line without a rate is skipped above: the review states it.
    requires_review: mirror || reviewsUnknownVat(tmpl, vatRegistered) || isStaleReduced12Match(
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
  /**
   * company_settings.vat_registered as the caller read it. Only true lets a
   * booking without moms correct a template at a rate: a company that is not
   * registered books such a template without moms (vatTreatmentForRegistration),
   * and a flag nobody read says nothing either way.
   */
  vatRegistered?: VatRegistration
  /**
   * The booking's moms are the template's own, as the caller established it:
   * the categorize doors booked the template as it replays
   * (counterparty_template_id), or the matcher's link found a verifikat with
   * the template's moms (lib/transactions/link-learning.ts). A template whose
   * moms is unknown replays none, and that replay, booked after a review, is
   * no sign that the purchase carries no moms.
   */
  momsAsTemplate?: boolean
}

/**
 * Find the template that owns a learned key: by counterparty_name first,
 * then by alias. A user rename moves the old key into counterparty_aliases
 * (PATCH /api/settings/counterparty-templates), so the alias leg is what
 * keeps re-approvals landing on the renamed row instead of inserting a
 * second template under the bank-derived name.
 */
export async function findTemplateByKey(
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
 * The kind of moms a template books or a booking carries, the rate aside:
 * none, Swedish moms (at a rate, or unknown moms of no one rate), or reverse
 * charge. What a stated reverse charge is checked against
 * (lib/transactions/categorize-core.ts); learning compares the moms itself
 * (learnedMoms).
 */
export type MomsKind = 'none' | 'rated' | 'reverse_charge'

export function momsKindOfTreatment(treatment: string | null | undefined): MomsKind {
  if (treatment === 'reverse_charge' || treatment === 'reverse_charge_domestic') return 'reverse_charge'
  return isRateBearing(treatment) || treatment === UNKNOWN_VAT ? 'rated' : 'none'
}

/**
 * The kind of moms a counterparty template replays. A single pair replays its
 * field. A pattern replays its own lines and never the field
 * (contradictsLearnedMoms): a moms line at a rate is booked whatever the field
 * or a basis pair beside it says, and only a basis pair books a reverse
 * charge (patternReplayPlan).
 */
export function momsKindOfTemplate(template: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>): MomsKind {
  const pattern = template.line_pattern
  if (!pattern || pattern.length === 0) return momsKindOfTreatment(template.vat_treatment)
  if (pattern.some((e) => e.type === 'vat' && !!e.vat_rate)) return 'rated'
  return patternReplayPlan(pattern).rcPair ? 'reverse_charge' : 'none'
}

/**
 * The moms a template replays, or a booking teaches, as one value: two that
 * differ are two different bookings. none, a rate (standard_25, reduced_12,
 * reduced_6), reverse_charge, 'unknown', or for a pattern with several moms
 * lines their accounts and rates.
 *
 * A single pair replays its field; export and exempt book no moms line, so
 * they are none. A pattern replays its own lines and never the field: a moms
 * line without a rate is unknown moms (extractVoucherLinePattern), one moms
 * line is its rate, and a pattern without one books reverse charge when it
 * holds a basis pair (patternReplayPlan), else none.
 */
export function learnedMoms(template: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>): string {
  const pattern = template.line_pattern
  if (!pattern || pattern.length === 0) {
    const treatment = template.vat_treatment
    if (treatment === 'reverse_charge' || treatment === 'reverse_charge_domestic') return 'reverse_charge'
    if (treatment === UNKNOWN_VAT || isRateBearing(treatment)) return treatment
    return 'none'
  }
  const vat = pattern.filter((e) => e.type === 'vat')
  if (vat.length === 0) return patternReplayPlan(pattern).rcPair ? 'reverse_charge' : 'none'
  if (vat.some((e) => !e.vat_rate)) return UNKNOWN_VAT
  if (vat.length === 1) return treatmentForRate(vat[0].vat_rate!) ?? UNKNOWN_VAT
  return vat.map((e) => `${e.account}@${e.vat_rate}`).sort().join('+')
}

/**
 * Whether a template's moms is unknown (learnedMoms): its bookings carried
 * moms that is no one Swedish rate of the net. It books no moms of its own,
 * and never without a review: replayed as none it drops the deductible moms,
 * replayed at a rate it deducts the wrong amount (13 kap. 6 § ML 2023:200
 * deducts the moms the invoice states, 17 kap. 24 § p. 11).
 */
export function hasUnknownVat(template: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>): boolean {
  return learnedMoms(template) === UNKNOWN_VAT
}

/**
 * Whether a template's unknown moms (hasUnknownVat) must be stated before it
 * books: for every company that books moms. One known not to be
 * VAT-registered books the gross without a moms line whatever the template
 * learned (keepsVatEntry, vatTreatmentForRegistration), so there is no moms
 * to state.
 */
export function reviewsUnknownVat(
  template: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>,
  vatRegistered: VatRegistration,
): boolean {
  return hasUnknownVat(template) && !isNotVatRegistered(vatRegistered)
}

/**
 * Whether moms booked contradicts the moms a template replays: another
 * value of learnedMoms, the rate and unknown moms included. A booking without
 * moms says nothing against moms at a rate (one rate, or a pattern's several
 * rated moms lines) unless the company is known to be VAT-registered, and
 * nothing against unknown moms for a company known not to be: one that is
 * not registered replays such a template without moms
 * (vatTreatmentForRegistration, keepsVatEntry).
 */
function contradictsLearnedMoms(
  template: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>,
  booked: string,
  vatRegistered: VatRegistration,
): boolean {
  const held = learnedMoms(template)
  if (booked === held) return false
  if (booked !== 'none') return true
  // A pattern's several moms lines read as account@rate pairs, each rated
  // (learnedMoms returns unknown for any line without a rate).
  const heldAtRates = isRateBearing(held) || held.includes('@')
  // A company that is not VAT-registered replays every such template
  // without moms (keepsVatEntry), unknown moms included.
  if (isNotVatRegistered(vatRegistered)) return !(heldAtRates || held === UNKNOWN_VAT)
  return !(heldAtRates && vatRegistered !== true)
}

/**
 * Whether a booking on a template's own accounts books other moms than the
 * template replays (contradictsLearnedMoms): the person correcting it, as
 * another account is. The whole booking is compared, moms included, so
 * another rate, moms where the template has none, or moms of no one rate
 * (unknown) is a correction, never one more approval of the old moms
 * (a pair learned without moms counted every booking with moms as
 * a confirmation, and proposed none forever). An SIE import's history is
 * compared too, as its accounts already are: counted as a confirmation, it
 * raised a template's count on bookings with other moms and kept its moms.
 * A booking whose moms are the template's own (momsAsTemplate), such as the
 * template's own replay, is no correction.
 */
export function learnsOtherMoms(
  existing: Pick<CategorizationTemplate, 'vat_treatment' | 'line_pattern'>,
  params: Pick<TemplateUpsertParams, 'vatTreatment' | 'linePattern' | 'source' | 'vatRegistered' | 'momsAsTemplate'>,
): boolean {
  if (params.momsAsTemplate) return false
  const booked = learnedMoms({
    vat_treatment: params.vatTreatment as TemplateVatTreatment | null,
    line_pattern: params.linePattern ?? null,
  })
  return contradictsLearnedMoms(existing, booked, params.vatRegistered)
}

/**
 * Low-level insert-or-update for a counterparty template.
 *
 * - existingTemplate undefined → DB lookup by (companyId, counterpartyName)
 * - existingTemplate null → skip lookup (batch mode: caller knows none exists)
 * - existingTemplate object → use directly (batch mode: pre-fetched)
 *
 * Re-approval: accumulates occurrence_count, recalculates confidence from total.
 * Correction (other accounts, or other moms: learnsOtherMoms): uses
 * params.occurrenceCount/confidence, updates accounts and moms. A
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
    const isCorrection = !samePairButBankLedger(existing, params.debitAccount, params.creditAccount, moneyLedgers) ||
      learnsOtherMoms(existing, params)

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
          // A booking that teaches a pair (no pattern) replaces a pattern too:
          // kept, the pattern went on replaying the accounts and moms the
          // booking had just corrected, since a pattern never reads the
          // fields above.
          line_pattern: params.linePattern ?? null,
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
          // The moms fields travel with the pattern they describe: a new
          // pattern beside the old field showed one moms on the Regler page
          // and booked another.
          ...(params.linePattern !== undefined
            ? { line_pattern: params.linePattern, vat_treatment: params.vatTreatment, vat_account: params.vatAccount }
            : {}),
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
  /** company_settings.vat_registered as the booking read it (TemplateUpsertParams.vatRegistered). */
  vatRegistered?: VatRegistration
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
 * tie them without the false matches removed earlier. The booking is the
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
  // The moms the booking carried, read off its lines against the payment
  // (SEK, as the lines are).
  const bookedVat = detectVatTreatment(
    mappingResult.vat_lines,
    Math.abs(resolveSekAmount(transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate)),
  )
  const bookedBasis = rcBasisKey(mappingResult.vat_lines)
  const unreplayableBasis =
    bookedVat === 'reverse_charge' &&
    bookedBasis !== '' &&
    bookedBasis !== rcBasisKey(learnedReverseChargeLines(100))

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
  if (unreplayableBasis) {
    // The booking teaches no pair, but it says a habit without reverse charge
    // is wrong: left as it was, a pair learned without moms kept coming back
    // as the row's proposal after every booking that rejected it. One
    // occurrence comes off, as a reversal takes one, so a habit with a long
    // history is not lost to one purchase.
    if (existing && rejectedByUnlearnableReverseCharge(existing)) {
      await takeOccurrenceBack(supabase, companyId, existing)
    }
    return
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
    vatTreatment: bookedVat,
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
    vatRegistered: options.vatRegistered,
    // Booked on this template: the lines are its replay, moms included.
    momsAsTemplate: !!existing && existing.id === options.bookedOnTemplateId,
  }, existing, moneyLedgers)
}

/**
 * Whether a reverse-charge purchase the pair cannot replay (its basis is not
 * the EU-services pair, crm#1028) rejects the template: an active
 * single-pair expense habit that books no reverse charge. One that books
 * reverse charge differs at most in an account or a basis it cannot store,
 * and may be right for the same name's EU purchases; a rule the person set
 * to book on its own ('auto') or a pattern template is theirs, not a habit.
 * All three are left alone.
 */
function rejectedByUnlearnableReverseCharge(existing: CategorizationTemplate): boolean {
  if (!existing.is_active || existing.mode === 'auto') return false
  if (existing.line_pattern && existing.line_pattern.length > 0) return false
  if (legacyTemplateDirection(existing.debit_account, existing.credit_account) !== 'expense') return false
  return momsKindOfTreatment(existing.vat_treatment) !== 'reverse_charge'
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
 * carries, with moms it does not contradict, is touched: a booking on other
 * accounts or with moms the template was corrected away from never taught
 * what it holds now. One
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
  /** The company's VAT registration (company_settings.vat_registered), as learning reads it. */
  vatRegistered?: VatRegistration,
): Promise<UnlearnOutcome | null> {
  const rawName = transaction.merchant_name || transaction.original_description || transaction.description
  if (!rawName || !namesCounterparty(rawName)) return null
  const normalized = normalizeCounterpartyName(rawName)
  if (!normalized || normalized.length < 2) return null

  const template = await findTemplateByKey(supabase, companyId, normalized)
  if (!template || !template.is_active || template.mode === 'auto') return null
  if (!verifikatCarriesPair(template, lines)) return null
  // A verifikat whose moms the template has since been corrected away from
  // (no moms, where it now books reverse charge or moms of no one rate) is
  // not what it holds now: taking its occurrence back would switch off the
  // corrected template. A pattern books its moms from its own lines, which a
  // pair's verifikat does not repeat, so its moms is not compared.
  const isPattern = !!template.line_pattern && template.line_pattern.length > 0
  if (!isPattern && contradictsLearnedMoms(template, verifikatMoms(template, lines), vatRegistered)) return null
  return takeOccurrenceBack(supabase, companyId, template)
}

/**
 * The moms a posted verifikat carried, as learning reads it (learnedMoms):
 * any fiktiv-moms account is reverse charge, else its moms lines off the
 * template's own accounts read against its gross, the larger side of its
 * lines off 26xx (the bank leg of a bank booking).
 */
function verifikatMoms(
  template: Pick<CategorizationTemplate, 'debit_account' | 'credit_account'>,
  lines: readonly MomsReadLine[],
): string {
  const momsLines = lines.filter((l) => l.account_number !== template.debit_account && l.account_number !== template.credit_account)
  if (momsLines.some((l) => REVERSE_CHARGE_VAT_ACCOUNTS.has(l.account_number))) return 'reverse_charge'
  let debit = 0
  let credit = 0
  for (const line of lines) {
    if (line.account_number.startsWith('26')) continue
    debit += Number(line.debit_amount) || 0
    credit += Number(line.credit_amount) || 0
  }
  return detectVatTreatment(momsLines, Math.max(roundOre(debit), roundOre(credit))) ?? 'none'
}

/**
 * One occurrence of a template comes off; a template left with none is
 * switched off, the same write as "Ta bort mall".
 */
async function takeOccurrenceBack(
  supabase: SupabaseClient,
  companyId: string,
  template: Pick<CategorizationTemplate, 'id' | 'occurrence_count'>,
): Promise<UnlearnOutcome | null> {
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

/** A booked line as the moms reading takes it. */
type MomsReadLine = { account_number: string; debit_amount: number | string; credit_amount: number | string }

/** Ingående moms, which names no rate: a purchase's moms account (264x) other than the fiktiv-moms ones. */
function isInputVatAccount(account: string): boolean {
  return vatAccountNature(account) === 'expense' && !REVERSE_CHARGE_VAT_ACCOUNTS.has(account)
}

/**
 * The moms a booking carried, read off its lines against the payment
 * (absGross, in SEK as the lines are): what a learned template stores and
 * what learning compares (learnsOtherMoms).
 *   - reverse_charge: fiktiv ingående moms on 2645;
 *   - a rate: the moms is that rate of the net (the gross less the moms),
 *     within rounding (rateOfStatedVat), on ingående moms (264x, which
 *     names no rate) or on utgående moms accounts of that rate (2611 is
 *     25 %);
 *   - unknown (UNKNOWN_VAT): moms of no one rate of the net, such as a mixed
 *     invoice's, ingående and utgående moms in one booking, or utgående
 *     moms of two rates;
 *   - null: no moms.
 * The rate is read off the amounts, never off a line's text: a line booked
 * from an underlag's moms amount states none ("Ingående moms (enligt
 * underlag)"). Read as 25 % by default, 125 kr of moms on a 725 kr
 * payment became a 25 % template, and a 12 % one a 25 % one.
 */
function detectVatTreatment(lines: readonly MomsReadLine[], absGross: number): TemplateVatTreatment | null {
  if (lines.some((l) => l.account_number === '2645')) return 'reverse_charge'

  let vat = 0
  let input = false
  const outputRates = new Set<VatTreatment>()
  for (const line of lines) {
    const output = outputVatTreatmentOfAccount(line.account_number)
    if (output) outputRates.add(output)
    else if (isInputVatAccount(line.account_number)) input = true
    else continue
    // Netted across the moms lines: a line taking back part of another
    // (a correction inside the verifikat) leaves only what was booked.
    vat += (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
  }
  vat = roundOre(Math.abs(vat))
  if (vat === 0) return null
  if (outputRates.size > 1 || (input && outputRates.size > 0)) return UNKNOWN_VAT

  const rate = rateOfStatedVat(vat, roundOre(absGross - vat))
  const treatment = rate === null ? null : treatmentForRate(rate)
  if (!treatment) return UNKNOWN_VAT
  const [named] = outputRates
  return named && named !== treatment ? UNKNOWN_VAT : treatment
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
  /** The voucher's fiktiv-moms accounts, sorted and joined; '' for none. */
  fiktivMoms: string
  /**
   * The voucher's moms lines as account@rate ('unknown' for a rate that could
   * not be read), sorted and joined; '' for none. Vouchers with other moms on
   * the same accounts are other bookings to the SIE learner.
   */
  vatKey: string
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
  const fiktivMoms = new Set<string>()

  for (const line of lines) {
    if (isSettlementAccount(line.account)) {
      settlement.push(line)
    } else if (isRoundingAccount(line.account)) {
      // Skip 3740 lines: rounding artifacts
      continue
    } else if (REVERSE_CHARGE_VAT_ACCOUNTS.has(line.account)) {
      // Fiktiv moms nets to zero inside the voucher: exclude it from the VAT
      // total (it must not shrink the base the business ratios use) and only
      // remember which accounts it was on.
      fiktivMoms.add(line.account)
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

  // VAT lines: store vat_rate, not ratio. A line whose rate cannot be read
  // keeps no vat_rate: unknown moms (learnedMoms), never dropped and never a
  // rate by default. Dropped, the voucher taught a pattern without moms, and
  // every later booking with moms on the same accounts counted as one more
  // approval of none.
  // 2641 (debiterad ingående moms) is rate-agnostic in BAS: the account
  // alone says nothing about 25/12/6 %. Its lines are one moms, summed, and
  // the rate is read off the voucher's own amounts (rateOfStatedVat): the
  // rate a replay books on the whole payment (buildMultiLineMappingResult),
  // so a rate is learned only where that replay gives the voucher's moms.
  // Beside another moms account the base of each is unknowable. Every other
  // moms account names its rate.
  const rateAgnostic = '2641'
  const inputVat = vat.filter((v) => v.account === rateAgnostic)
  const inputVatNet = roundOre(inputVat.reduce((sum, v) => sum + v.amount, 0))
  const inputVatRate =
    inputVat.length === vat.length ? rateOfStatedVat(Math.abs(inputVatNet), nonVatTotal) : null
  const momsLines = [
    ...(inputVat.length > 0 && inputVatNet !== 0 ? [{ account: rateAgnostic, amount: inputVatNet }] : []),
    ...vat.filter((v) => v.account !== rateAgnostic),
  ]
  for (const v of momsLines) {
    let rate: number | undefined
    if (v.account === rateAgnostic) {
      rate = inputVatRate ?? undefined
    } else {
      rate = vatTreatmentToRate(VAT_ACCOUNT_TREATMENT[v.account])
      if (rate === 0) continue
    }
    entries.push({
      account: v.account,
      type: 'vat',
      side: v.amount >= 0 ? 'debit' : 'credit',
      ...(rate !== undefined ? { vat_rate: rate } : {}),
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
    hasReverseCharge: fiktivMoms.size > 0,
    fiktivMoms: [...fiktivMoms].sort().join(','),
    vatKey: entries
      .filter((e) => e.type === 'vat')
      .map((e) => `${e.account}@${e.vat_rate ?? UNKNOWN_VAT}`)
      .sort()
      .join('+'),
  }
}

/** The amount a replay is simulated on (replayedFiktivMomsKey): large enough that no ratio rounds away. */
const REPLAY_PROBE_AMOUNT = 10000

/**
 * The fiktiv-moms accounts a learned shape books when it is replayed, sorted
 * and joined, '' when it books none. A simple shape replays the legacy set
 * (learnedReverseChargeLines), and only on a purchase without a deductible
 * moms line beside it (learnedPairVatLines, templateFieldsFromVoucherPatterns);
 * a line pattern replays its basis pair's set (patternReverseChargeLines), none
 * without a pair. Both settled on their cost lines as the booking door settles
 * them (reverseChargePurchasesOn), with no momskod known: a cost line on a
 * basis account takes its own sats. null when the replay would book the
 * purchase's basis twice: a cost line on an import account (4545-4547, ruta
 * 50) gets a reverse-charge basis pair (ruta 20-24) beside it.
 */
function replayedFiktivMomsKey(
  entries: readonly LinePatternEntry[],
  settlementSide: 'debit' | 'credit',
): string | null {
  let purchase: { base: number; rate: number; kind: ReverseChargeKind }
  let costLines: { account: string; amount: number }[]
  if (isSimpleShape(entries)) {
    const business = entries.find((e) => e.type === 'business')
    // A business line on the credit side is a sale or a credit note, and so
    // is a template whose settlement (its first settlement line) is debited:
    // the simple builder books reverse charge on neither sign of them.
    if (
      !business || business.side !== 'debit' || settlementSide !== 'credit' ||
      entries.some((e) => e.type === 'vat')
    ) return ''
    purchase = { base: REPLAY_PROBE_AMOUNT, rate: resolveReverseChargeRate({}), kind: DEFAULT_REVERSE_CHARGE_KIND }
    costLines = [{ account: business.account, amount: REPLAY_PROBE_AMOUNT }]
  } else {
    // As buildMultiLineMappingResult shares a payment with no moms line.
    const { rcPair, entries: rest, ratioScale } = patternReplayPlan(entries)
    if (!rcPair) return ''
    costLines = rest
      .filter((e) => e.type === 'business' && e.side === rcPair.basis.side && (e.ratio ?? 0) > 0)
      .map((e) => ({ account: e.account, amount: roundOre(REPLAY_PROBE_AMOUNT * (e.ratio ?? 0) * ratioScale) }))
    purchase = { base: REPLAY_PROBE_AMOUNT, rate: rcPair.rate, kind: rcPair.kind }
  }
  if (costLines.some((line) => isImportBasisAccount(line.account))) return null
  const accounts = reverseChargePurchasesOn(purchase, costLines, new Map())
    .flatMap(generateReverseChargePurchaseLines)
    .map((line) => line.account_number)
    .filter((account) => REVERSE_CHARGE_VAT_ACCOUNTS.has(account))
  return [...new Set(accounts)].sort().join(',')
}

/** Whether an account occurs on more than one of the entries. */
function repeatsAccount(entries: readonly Pick<LinePatternEntry, 'account'>[]): boolean {
  return new Set(entries.map((e) => e.account)).size !== entries.length
}

/**
 * A shape the simple builder books from the legacy fields: one business line,
 * at most one VAT line, no tax line. Any other is stored as a line_pattern.
 */
function isSimpleShape(entries: readonly LinePatternEntry[]): boolean {
  let business = 0
  let vat = 0
  for (const e of entries) {
    if (e.type === 'tax') return false
    if (e.type === 'business') business++
    if (e.type === 'vat') vat++
  }
  return business === 1 && vat <= 1
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
 * The template fields a group of same-shaped verifikat teaches: the averaged
 * line pattern, and the legacy debit/credit/VAT fields the simple builder
 * reads. A simple shape (one business line, at most one VAT line, no tax
 * line) is stored on the legacy fields alone; any other keeps its
 * line_pattern. The settlement leg is the first verifikat's. One rule for the
 * SIE learner and the bank-link learner (lib/transactions/link-learning.ts).
 */
function templateFieldsFromVoucherPatterns(
  voucherPatterns: VoucherLinePattern[],
): (Pick<TemplateUpsertParams, 'debitAccount' | 'creditAccount' | 'vatTreatment' | 'vatAccount'> & {
  linePattern: LinePatternEntry[] | null
}) | null {
  // Average the line patterns from all vouchers in the group
  const avgPattern = averageLinePatterns(voucherPatterns)

  // A replay regenerates the fiktiv moms instead of reading it back, so a
  // group whose fiktiv moms the replay of what it teaches would book on other
  // accounts teaches nothing (#997): import VAT (2615, ruta 60) came back as
  // 2614 (ruta 30) beside a 4535 basis (ruta 21), domestic reverse charge's
  // basis in ruta 21 instead of 24, 12 % as 25 %, and a pattern with an import
  // pair (4545) lost its moms. Judged on the averaged pattern, which is what
  // is stored and replayed. Averaging keeps one line per account, so a line
  // pattern whose voucher books a basis or offset account twice (two basis
  // pairs on one 4598, one per sats) replays another split of the sats and
  // teaches nothing either; a cost account booked on several lines merges as
  // it does without reverse charge. A line pattern with a basis pair replays
  // fiktiv moms whether or not its vouchers booked any, so it is judged too,
  // and a replay that would book the basis twice (an import account beside a
  // generated pair) teaches nothing. A categorize booking whose replay would
  // land in another ruta teaches nothing too (crm#1028).
  const { settlementAccount, settlementSide } = voucherPatterns[0]
  const rcPair = isSimpleShape(avgPattern) ? null : patternReplayPlan(avgPattern).rcPair
  if (rcPair !== null || voucherPatterns.some((vp) => vp.fiktivMoms !== '')) {
    const replayed = replayedFiktivMomsKey(avgPattern, settlementSide)
    const isPairLeg = (account: string) =>
      reverseChargeKindForBasisAccount(account) !== null ||
      account === rcPair?.basis.account ||
      account === rcPair?.offset.account
    if (replayed === null || voucherPatterns.some((vp) =>
      vp.fiktivMoms !== replayed ||
      (rcPair !== null && repeatsAccount(vp.entries.filter((e) => isPairLeg(e.account)))),
    )) return null
  }

  // Decide: simple (1 business + 0-1 VAT) → legacy fields; otherwise → line_pattern
  const businessEntries = avgPattern.filter(e => e.type === 'business')
  const vatEntries = avgPattern.filter(e => e.type === 'vat')
  const isSimple = isSimpleShape(avgPattern)

  // Determine primary business account and settlement for debit/credit fields
  const primaryBusiness = businessEntries.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0]

  let debitAccount: string
  let creditAccount: string
  if (settlementSide === 'debit') {
    debitAccount = settlementAccount
    creditAccount = primaryBusiness?.account ?? settlementAccount
  } else {
    debitAccount = primaryBusiness?.account ?? settlementAccount
    creditAccount = settlementAccount
  }

  // VAT info from first VAT entry (for legacy fields). The learned rate is
  // authoritative: for 2641 it was inferred from the voucher amounts, so
  // mapping it back through the account table would re-hardcode 25%. A moms
  // line whose rate could not be read makes the template's moms unknown.
  const firstVat = vatEntries[0]
  let vatAccount = firstVat?.account ?? null
  let vatTreatment: string | null = vatEntries.some((e) => e.vat_rate === undefined)
    ? UNKNOWN_VAT
    : firstVat?.vat_rate !== undefined ? treatmentForRate(firstVat.vat_rate) : null

  // Reverse-charge counterparty (fiktiv moms in every source voucher, no
  // deductible VAT): the simple builder regenerates the RC legs from the
  // treatment, so record it on the legacy fields.
  if (
    isSimple &&
    !vatAccount &&
    voucherPatterns.every(vp => vp.hasReverseCharge)
  ) {
    vatTreatment = 'reverse_charge'
    vatAccount = '2645'
  }

  return { debitAccount, creditAccount, vatTreatment, vatAccount, linePattern: isSimple ? null : avgPattern }
}

/** The SIE learner's group key: the pattern's accounts, sorted and joined. */
function patternAccountSet(entries: readonly Pick<LinePatternEntry, 'account'>[]): string {
  return entries
    .map(e => e.account)
    .sort()
    .join('+')
}

/** A verifikat's template fields plus its shape key (verifikatTemplateShape). */
export type VerifikatTemplateShape = NonNullable<ReturnType<typeof templateFieldsFromVoucherPatterns>> & {
  accountSet: string
}

/**
 * What one posted verifikat teaches as a counterparty template, read the way
 * the SIE learner reads an imported voucher (extractVoucherLinePattern):
 * pension plus särskild löneskatt stays one multi-line template. `lines` are
 * signed like SIE amounts (debit positive). `accountSet` is the shape's
 * account key, the one the SIE learner groups vouchers by beside their
 * fiktiv-moms accounts (populateTemplatesFromSieVouchers). null when the verifikat
 * cannot be a pattern (no business line, no settlement line, more than five
 * business accounts, nothing left beside the VAT), or when its replay would
 * book its fiktiv moms on other accounts (templateFieldsFromVoucherPatterns).
 */
export function verifikatTemplateShape(
  lines: { account: string; amount: number; dimensions?: Record<string, string> }[],
): VerifikatTemplateShape | null {
  const pattern = extractVoucherLinePattern(lines)
  if (!pattern) return null
  const fields = templateFieldsFromVoucherPatterns([pattern])
  if (!fields) return null
  return { accountSet: patternAccountSet(pattern.entries), ...fields }
}

/**
 * A stored template's shape key in verifikatTemplateShape's terms: its line
 * pattern's accounts, or for a simple template its business leg and its VAT
 * account. Reverse-charge VAT accounts are left out on both sides, as the
 * extractor leaves them out of a pattern.
 */
export function templateAccountSet(
  template: Pick<CategorizationTemplate, 'debit_account' | 'credit_account' | 'vat_account' | 'line_pattern'>,
): string {
  if (template.line_pattern && template.line_pattern.length > 0) return patternAccountSet(template.line_pattern)
  const accounts = [template.debit_account, template.credit_account].filter(a => !isSettlementAccount(a))
  if (template.vat_account && !REVERSE_CHARGE_VAT_ACCOUNTS.has(template.vat_account)) accounts.push(template.vat_account)
  return patternAccountSet(accounts.map(account => ({ account })))
}

/**
 * Bank or voucher text that names a bookkeeping routine, not a counterparty
 * ("Lön", "Moms", "Skattebetalning"): the SIE learner skips such voucher texts,
 * and the bank-link learner skips such bank texts by the same list.
 */
export function isRoutineVoucherText(normalizedName: string): boolean {
  return SIE_SKIP_DESCRIPTIONS.has(normalizedName)
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

    // Group key: sorted set of non-settlement accounts, and the fiktiv-moms
    // accounts, which the pattern leaves out: import VAT and EU reverse
    // charge on the same cost account are two shapes, and the dominant one
    // decides (#997). So are other moms on the same accounts (another rate,
    // or moms of no one rate): averaged together, the first voucher's rate
    // stood for all of them.
    const accountSet = patternAccountSet(linePattern.entries)
    const groupKey = `${normalized}|${accountSet}|${linePattern.fiktivMoms}|${linePattern.vatKey}`

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
    fields: NonNullable<ReturnType<typeof templateFieldsFromVoucherPatterns>>
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

    // A dominant shape that teaches nothing leaves the counterparty untaught:
    // a minority shape never stands in for it.
    const fields = templateFieldsFromVoucherPatterns(dominant.voucherPatterns)
    if (!fields) continue

    const confidence = Math.round(Math.min(0.95, dominance * (1 - 1 / dominant.count)) * 100) / 100

    accepted.push({
      normalizedName: group.normalizedName,
      aliases: [...group.aliases],
      pattern: dominant,
      fields,
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

    const written = await insertOrUpdateTemplate(supabase, companyId, {
      counterpartyName: item.normalizedName,
      aliases: item.aliases,
      ...item.fields,
      category: null,
      occurrenceCount: item.pattern.count,
      confidence: item.confidence,
      lastSeenDate: toDateString(item.pattern.latestDate),
      source: 'sie_import',
    }, existing)

    if (written) count += 1
  }

  return count
}
