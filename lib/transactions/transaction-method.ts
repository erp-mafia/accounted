/**
 * Classify HOW a bank/feed transaction moved (its payment rail) into the
 * closed `TransactionMethod` vocabulary, and derive the clean display title.
 *
 * Swedish bank feeds embed the channel in the description text itself: the
 * PSD2 remittance array arrives as ["Vercel Jul", "Överföring via internet"]
 * and is joined into one string at conversion, so "Kortköp/uttag",
 * "Bg-bet. via internet", "Europabetalning" etc. ride along as a trailing
 * phrase. This module is the single place that vocabulary lives: it both
 * classifies the phrase into a structured method AND strips it off the
 * working title, so the list shows "Vercel Jul" and the method becomes a
 * queryable field (a card purchase implies a physical receipt exists; a
 * Bankgiro/e-invoice payment implies a supplier invoice).
 *
 * Precedence (most trustworthy first):
 *   1. An explicit method from the source (the Stripe feed knows its own
 *      balance-transaction types).
 *   2. The trailing Swedish channel phrase in the description: bank-authored
 *      and more specific than the ISO family (the ISO code for a Bankgiro
 *      payment is just "issued credit transfer").
 *   3. ISO 20022 bank_transaction_code domain/family (+ subfamily override).
 *   4. Keyword scan over the raw (often proprietary) code strings.
 *   5. MCC presence: only card transactions carry an MCC (6011 = ATM).
 *
 * Title stripping is independent of which source won: whenever a trailing
 * phrase is found it is removed, but the title is never emptied (a
 * description that IS the phrase, e.g. a bare "Insättning", is kept).
 * Stripping a trailing phrase leaves a PREFIX of the original string, which
 * the content-dedup bridge (descriptionsBridge, prefix containment) is built
 * to survive; the full bank string is preserved in original_description.
 *
 * Pure and side-effect free. The SQL backfill in migration 20260808090100
 * duplicates the phrase vocabulary as a one-shot snapshot; it does NOT need
 * to stay in sync (post-migration rows are classified here at ingest).
 */

import type { TransactionMethod } from '@/types'

export interface TransactionMethodInput {
  /** Normalized full source description (the ingest boundary's original). */
  description: string
  /** ISO 20022 bank transaction code, e.g. "PMNT-CCRD-POSD" or "PMNT/ICDT". */
  bankTransactionCode?: string | null
  /** ASPSP-proprietary code (free-form, varies per bank). */
  proprietaryBankTransactionCode?: string | null
  /** Merchant category code: present only on card-rail transactions. */
  mccCode?: number | null
  /** Method the source already knows structurally (e.g. Stripe txn.type). */
  explicitMethod?: TransactionMethod | null
}

export interface ClassifiedTransactionMethod {
  method: TransactionMethod | null
  /**
   * Description with the trailing channel phrase stripped: what the user sees
   * as the row title. Equals `description` when no phrase matched or when
   * stripping would empty the title.
   */
  displayTitle: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Trailing channel phrases, checked in order: first match wins, so longer /
 * more specific variants must precede their substrings ("överföring via
 * internet" before "överföring", "kortköp/uttag" before "kortköp"). The bare
 * "lön" sits last: it is the riskiest token and must never shadow a more
 * specific phrase.
 */
const TRAILING_PHRASES: ReadonlyArray<readonly [string, TransactionMethod]> = [
  ['kortköp/uttag', 'card'],
  ['kortköp', 'card'],
  ['kortbetalning', 'card'],
  ['webbköp', 'card'],
  ['bg-bet. via internet', 'bankgiro'],
  ['bg-bet via internet', 'bankgiro'],
  ['bg-betalning', 'bankgiro'],
  ['bg betalning', 'bankgiro'],
  ['bgmax', 'bankgiro'],
  ['bg-inb', 'bankgiro'],
  ['bankgiro', 'bankgiro'],
  ['bg-bet.', 'bankgiro'],
  ['bg-bet', 'bankgiro'],
  ['pg-betalning', 'plusgiro'],
  ['pg betalning', 'plusgiro'],
  ['plusgiro', 'plusgiro'],
  ['europabetalning', 'international'],
  ['utlandsbetalning', 'international'],
  ['löneinsättning', 'salary'],
  ['lönebetalning', 'salary'],
  ['löneutbetalning', 'salary'],
  ['e-faktura', 'e_invoice'],
  ['efaktura', 'e_invoice'],
  ['swish-betalning', 'swish'],
  ['swish betalning', 'swish'],
  ['swish', 'swish'],
  ['autogirobetalning', 'autogiro'],
  ['autogiro', 'autogiro'],
  ['pris betalning', 'fee'],
  ['prisbetalning', 'fee'],
  ['avgift', 'fee'],
  ['insättningsränta', 'interest'],
  ['ränta', 'interest'],
  ['kontantinsättning', 'deposit'],
  ['insättning', 'deposit'],
  ['bankomatuttag', 'withdrawal'],
  ['kontantuttag', 'withdrawal'],
  ['uttag', 'withdrawal'],
  ['överföring via internet', 'transfer'],
  ['överföring via mobil', 'transfer'],
  ['överföring via app', 'transfer'],
  ['överföring inom banken', 'transfer'],
  ['överföring inom bank', 'transfer'],
  ['överföring mellan konton', 'transfer'],
  ['direktöverföring', 'transfer'],
  ['direktbetalning', 'transfer'],
  ['internetbetalning', 'transfer'],
  ['mobilbetalning', 'transfer'],
  ['överföring', 'transfer'],
  ['lön', 'salary'],
]

const TRAILING_PHRASE_RULES = TRAILING_PHRASES.map(([phrase, method]) => ({
  method,
  // Anchored at the end, preceded by start-of-string or whitespace so a
  // phrase inside a word never matches ("Löneinsättning" is salary, not
  // deposit; "Bankavgift" is untouched by the bare "avgift" rule).
  regex: new RegExp(`(?:^|\\s)${escapeRegExp(phrase)}\\s*$`, 'i'),
}))

/** Leading patterns: classification signal only, never stripped. */
const LEADING_RULES: ReadonlyArray<readonly [RegExp, TransactionMethod]> = [
  [/^swish (?:till|från)(?:\s|$)/i, 'swish'],
]

/**
 * Possessive/scope adjectives whose meaning depends on the noun after them:
 * "Egen insättning" must not become "Egen" (the phrase IS the meaning there).
 * When the stripped title would END in one of these, the strip is skipped;
 * the method classification still applies. Mirrored by the adjective guard in
 * the 20260808090100 backfill.
 */
const ADJECTIVE_GUARD = new Set([
  'egen', 'eget', 'egna', 'privat', 'privata', 'intern', 'interna', 'extern', 'externa',
])

/** ISO 20022 External Bank Transaction Codes, keyed by DOMAIN/FAMILY. */
const ISO_FAMILY_METHODS: Record<string, TransactionMethod> = {
  'PMNT/RCDT': 'transfer', // ReceivedCreditTransfers
  'PMNT/ICDT': 'transfer', // IssuedCreditTransfers
  'PMNT/CCRD': 'card', // CustomerCardTransactions
  'PMNT/MCRD': 'card', // MerchantCardTransactions
  'PMNT/RDDT': 'autogiro', // ReceivedDirectDebits
  'PMNT/IDDT': 'autogiro', // IssuedDirectDebits
  'PMNT/CWDL': 'withdrawal', // CashWithdrawal
  'PMNT/CAJT': 'adjustment', // CashAdjustments
}

/** Subfamily refinements that beat the family default. */
const ISO_SUBFAMILY_METHODS: Record<string, TransactionMethod> = {
  SALA: 'salary', // SalaryPayment
  XBCT: 'international', // CrossBorderCreditTransfer
  ESCT: 'international', // SEPACreditTransfer
}

/** Keyword → method over raw code strings (covers proprietary formats). */
const CODE_KEYWORD_METHODS: ReadonlyArray<readonly [RegExp, TransactionMethod]> = [
  [/SWISH/i, 'swish'],
  [/AUTOGIRO/i, 'autogiro'],
  [/INTRST|INTEREST|RÄNTA|RANTA/i, 'interest'],
  [/\bFEE\b|CHRG|CHARGE|AVGIFT/i, 'fee'],
  [/ATM|CASH.?WDL|WITHDRAW|UTTAG/i, 'withdrawal'],
  [/\bCARD\b|KORT|\bPOS\b/i, 'card'],
  [/SALA|SALARY|\bLÖN\b|\bLON\b/i, 'salary'],
]

function methodFromCodes(codes: string[]): TransactionMethod | null {
  // Two passes so a subfamily refinement on EITHER code beats a family match
  // on the other: with one combined pass, a family hit on the ISO code would
  // short-circuit before the proprietary code's subfamily is inspected.
  const partsList = codes.map((raw) => raw.toUpperCase().split(/[/\-_.\s]+/).filter(Boolean))
  for (const parts of partsList) {
    if (parts.length >= 3 && ISO_SUBFAMILY_METHODS[parts[2]]) {
      return ISO_SUBFAMILY_METHODS[parts[2]]
    }
  }
  for (const parts of partsList) {
    if (parts.length >= 2) {
      const family = ISO_FAMILY_METHODS[`${parts[0]}/${parts[1]}`]
      if (family) return family
    }
  }
  for (const raw of codes) {
    for (const [re, method] of CODE_KEYWORD_METHODS) {
      if (re.test(raw)) return method
    }
  }
  return null
}

export function classifyTransactionMethod(
  input: TransactionMethodInput
): ClassifiedTransactionMethod {
  const description = (input.description ?? '').trim()

  // Trailing phrase: sole source of the clean title, and the strongest
  // text-level method signal.
  let phraseMethod: TransactionMethod | null = null
  let displayTitle = description
  for (const rule of TRAILING_PHRASE_RULES) {
    if (rule.regex.test(description)) {
      phraseMethod = rule.method
      const stripped = description.replace(rule.regex, '').trim()
      const lastWord = stripped.toLowerCase().split(/\s+/).filter(Boolean).at(-1)
      if (stripped.length > 0 && (!lastWord || !ADJECTIVE_GUARD.has(lastWord))) {
        displayTitle = stripped
      }
      break
    }
  }

  let leadingMethod: TransactionMethod | null = null
  for (const [re, method] of LEADING_RULES) {
    if (re.test(description)) {
      leadingMethod = method
      break
    }
  }

  const codes = [input.bankTransactionCode, input.proprietaryBankTransactionCode].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0
  )

  const mccMethod: TransactionMethod | null =
    input.mccCode != null ? (input.mccCode === 6011 ? 'withdrawal' : 'card') : null

  const method =
    input.explicitMethod ??
    phraseMethod ??
    leadingMethod ??
    methodFromCodes(codes) ??
    mccMethod

  return { method, displayTitle }
}
