/**
 * proposePurchaseCategory: what an underlag bought, proposed from evidence
 * the system already holds. Pure and deterministic: no model call, no I/O.
 * Same input, same answer, so a proposal can be explained and tested.
 *
 * The evidence ladder, first match wins:
 *
 *   1. A person's own choice for this underlag (the override): 'Ditt val'.
 *   1b. A person's instruction for the supplier ("varje gång", the
 *      supplier's default_purchase_category): 'Ditt val', source
 *      'instruction'. It never outranks a choice on a single underlag, and
 *      it outranks everything learned below.
 *   2. Not a purchase (a letter from a myndighet, a contract): no proposal.
 *   3. The counterparty's booked history, when its dominant account maps to
 *      exactly one category: 'Stark' with enough clean hits, 'Trolig' with
 *      fewer. The document's own lines outrank it when they clearly say
 *      something else: a mixed store (a hardware chain, a marketplace) is
 *      booked on one account whatever was in the bag, and the lines are what
 *      this purchase was. When the dominant account is shared by several
 *      categories (5420: a subscription or a licence), clean history and the
 *      document agreeing on one of them, through the lines or the merchant
 *      kind, is also 'Stark': two independent sources point the same way.
 *   4. The lines: keywords on the line descriptions, weighed by amount; one
 *      category must carry most of the document. 'Trolig'.
 *   5. A suggested account that maps to exactly one category: 'Trolig'.
 *   6. The merchant kind (extraction's merchantCategory, or a generic word in
 *      the supplier's name) when it means one category, or narrows to one
 *      together with the accounts above: 'Trolig'.
 *
 * Anything ambiguous answers null rather than a guess: a restaurant receipt
 * is a client meal or a staff meal, and only a person or the books can say
 * which.
 *
 * The taxonomy is country-neutral; the accounts are read through a country
 * pack (Sweden's BAS map by default).
 */
import { SE_PURCHASE_CATEGORY_PACK } from '@/lib/bookkeeping/bas-data/purchase-category-accounts'
import {
  isPurchaseCategoryCode,
  PURCHASE_CATEGORY_CODES,
  type PurchaseCategoryAccountPack,
  type PurchaseCategoryCode,
} from './purchase-categories'
import {
  MERCHANT_KIND_CATEGORIES,
  PURCHASE_CATEGORY_KEYWORDS,
  SUPPLIER_NAME_KINDS,
} from './purchase-category-keywords'

export type PurchaseCategorySource = 'person' | 'instruction' | 'counterparty' | 'account' | 'merchant_category' | 'lines'

/** How much the proposal rests on, in the words the inbox shows. */
export type PurchaseCategoryLevel = 'Ditt val' | 'Stark' | 'Trolig'

export interface PurchaseCategoryProposal {
  code: PurchaseCategoryCode
  source: PurchaseCategorySource
  level: PurchaseCategoryLevel
}

export interface PurchaseCategoryLineInput {
  description?: string | null
  lineTotal?: number | null
}

export interface PurchaseCategoryInput {
  /** The code a person chose for this underlag, if any. Unknown codes are ignored. */
  override?: string | null
  /**
   * The code a person said once for every underlag from this supplier
   * ("varje gång"), if any. Unknown codes are ignored.
   */
  supplierInstruction?: string | null
  /**
   * The counterparty's dominant booked account and its clean hits (bookings
   * that followed the learned pattern: occurrences minus corrections).
   */
  counterparty?: { account: string; cleanHits: number } | null
  /** What extraction read off the document. */
  extraction?: {
    documentKind?: string | null
    merchantCategory?: string | null
    lineItems?: readonly PurchaseCategoryLineInput[] | null
    supplierName?: string | null
  } | null
  /** An account suggested for the purchase (a supplier's default, an agent's line account). */
  suggestedAccount?: string | null
}

/** Clean hits a counterparty needs before its history counts as strong. */
export const STRONG_MIN_CLEAN_HITS = 3

/** Share of the document's line value one category must carry for the lines to decide. */
export const LINE_DOMINANT_SHARE = 0.6

/** Document kinds that are not purchases: nothing to categorise. */
const NOT_PURCHASES = new Set(['government_letter', 'other'])

// ── Keyword matching ──────────────────────────────────────────

interface CompiledKeyword {
  text: string
  /** Letters in the keyword, the tie-breaker: the more specific word wins. */
  weight: number
  mode: 'word' | 'prefix' | 'substring'
}

/** Lower case, punctuation to single spaces, diacritics kept, padded with spaces. */
export function normalizeCategoryText(raw: string): string {
  const folded = raw.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return folded ? ` ${folded} ` : ''
}

function compileKeyword(raw: string): CompiledKeyword {
  const forcedWord = raw.startsWith('=')
  const text = normalizeCategoryText(forcedWord ? raw.slice(1) : raw).trim()
  const weight = text.replace(/ /g, '').length
  const mode = forcedWord || weight < 5 ? 'word' : text.includes(' ') ? 'prefix' : 'substring'
  return { text, weight, mode }
}

function matchKeyword(padded: string, keyword: CompiledKeyword): boolean {
  switch (keyword.mode) {
    case 'word':
      return padded.includes(` ${keyword.text} `)
    case 'prefix':
      return padded.includes(` ${keyword.text}`)
    case 'substring':
      return padded.includes(keyword.text)
  }
}

interface CompiledCategory {
  code: PurchaseCategoryCode
  strong: CompiledKeyword[]
  weak: CompiledKeyword[]
}

const COMPILED: readonly CompiledCategory[] = PURCHASE_CATEGORY_CODES.flatMap((code) => {
  const keywords = PURCHASE_CATEGORY_KEYWORDS[code]
  if (!keywords) return []
  return [{ code, strong: keywords.strong.map(compileKeyword), weak: (keywords.weak ?? []).map(compileKeyword) }]
})

function bestInTier(padded: string, tier: 'strong' | 'weak'): PurchaseCategoryCode | null | undefined {
  let best = 0
  let winners = new Set<PurchaseCategoryCode>()
  for (const category of COMPILED) {
    for (const keyword of category[tier]) {
      if (keyword.weight < best || !matchKeyword(padded, keyword)) continue
      if (keyword.weight > best) {
        best = keyword.weight
        winners = new Set()
      }
      winners.add(category.code)
    }
  }
  if (winners.size === 0) return undefined
  return winners.size === 1 ? [...winners][0] : null
}

/**
 * The category one line's text names: the longest strong keyword, else the
 * longest weak one. Null when nothing matches or two categories tie.
 */
export function categoryOfLine(description: string | null | undefined): PurchaseCategoryCode | null {
  const padded = normalizeCategoryText(description ?? '')
  if (!padded) return null
  const strong = bestInTier(padded, 'strong')
  if (strong !== undefined) return strong
  return bestInTier(padded, 'weak') ?? null
}

/**
 * The category the lines are about: each line's category weighed by its
 * amount (by count when the document has no amounts), and one category must
 * carry LINE_DOMINANT_SHARE of all lines, the undecided ones included. A
 * receipt where the only line we recognise is the shipping fee says nothing
 * about the rest of the bag.
 */
export function dominantLineCategory(
  lines: readonly PurchaseCategoryLineInput[] | null | undefined,
): PurchaseCategoryCode | null {
  if (!lines || lines.length === 0) return null
  const amounts = lines.map((l) =>
    typeof l.lineTotal === 'number' && Number.isFinite(l.lineTotal) ? Math.abs(l.lineTotal) : 0,
  )
  const byCount = amounts.every((a) => a === 0)
  const weights = byCount ? lines.map(() => 1) : amounts
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return null

  const score = new Map<PurchaseCategoryCode, number>()
  lines.forEach((line, i) => {
    const code = categoryOfLine(line.description)
    if (code) score.set(code, (score.get(code) ?? 0) + weights[i])
  })
  let top: PurchaseCategoryCode | null = null
  let topScore = 0
  for (const [code, value] of score) {
    if (value > topScore) {
      top = code
      topScore = value
    }
  }
  return top && topScore / total >= LINE_DOMINANT_SHARE ? top : null
}

/** The merchant kind a supplier name gives away by a generic word in it, if any. */
export function merchantKindOfSupplierName(name: string | null | undefined): string | null {
  const padded = normalizeCategoryText(name ?? '')
  if (!padded) return null
  const kinds = Object.entries(SUPPLIER_NAME_KINDS)
    .filter(([, words]) => words.some((w) => matchKeyword(padded, compileKeyword(w))))
    .map(([kind]) => kind)
  return kinds.length === 1 ? kinds[0] : null
}

// ── The proposal ──────────────────────────────────────────────

function propose(code: PurchaseCategoryCode, source: PurchaseCategorySource, level: PurchaseCategoryLevel) {
  return { code, source, level }
}

export function proposePurchaseCategory(
  input: PurchaseCategoryInput,
  pack: PurchaseCategoryAccountPack = SE_PURCHASE_CATEGORY_PACK,
): PurchaseCategoryProposal | null {
  if (isPurchaseCategoryCode(input.override)) return propose(input.override, 'person', 'Ditt val')
  if (isPurchaseCategoryCode(input.supplierInstruction)) return propose(input.supplierInstruction, 'instruction', 'Ditt val')

  const extraction = input.extraction ?? null
  if (extraction?.documentKind && NOT_PURCHASES.has(extraction.documentKind)) return null

  const lines = dominantLineCategory(extraction?.lineItems)

  const counterparty = input.counterparty ?? null
  const fromHistory = counterparty ? pack.categoriesFor(counterparty.account) : []
  if (counterparty && fromHistory.length === 1) {
    if (lines && lines !== fromHistory[0]) return propose(lines, 'lines', 'Trolig')
    const strong = counterparty.cleanHits >= STRONG_MIN_CLEAN_HITS
    return propose(fromHistory[0], 'counterparty', strong ? 'Stark' : 'Trolig')
  }

  const kind =
    extraction?.merchantCategory && extraction.merchantCategory !== 'other'
      ? extraction.merchantCategory
      : merchantKindOfSupplierName(extraction?.supplierName)
  const fromKind = kind ? MERCHANT_KIND_CATEGORIES[kind] ?? [] : []

  // A shared account and the document agreeing on one of its categories.
  if (counterparty && fromHistory.length > 1 && counterparty.cleanHits >= STRONG_MIN_CLEAN_HITS) {
    if (lines && fromHistory.includes(lines)) return propose(lines, 'counterparty', 'Stark')
    if (!lines) {
      const agreed = fromKind.filter((code) => fromHistory.includes(code))
      if (agreed.length === 1) return propose(agreed[0], 'counterparty', 'Stark')
    }
  }

  if (lines) return propose(lines, 'lines', 'Trolig')

  const fromAccount = input.suggestedAccount ? pack.categoriesFor(input.suggestedAccount) : []
  if (fromAccount.length === 1) return propose(fromAccount[0], 'account', 'Trolig')

  if (fromKind.length === 1) return propose(fromKind[0], 'merchant_category', 'Trolig')
  if (fromKind.length > 1) {
    // The accounts cannot decide alone (several candidates each), but together
    // with the merchant kind they may leave exactly one.
    const accounts = new Set([...fromHistory, ...fromAccount])
    const narrowed = fromKind.filter((code) => accounts.has(code))
    if (narrowed.length === 1) return propose(narrowed[0], 'merchant_category', 'Trolig')
  }
  return null
}
