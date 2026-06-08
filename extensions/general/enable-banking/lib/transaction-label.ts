/**
 * Derive a Swedish, human-readable working label for a bank transaction from
 * the structured codes an ASPSP DOES send when free-text remittance and a
 * counterparty name are both absent — the classic card-purchase / ATM / fee /
 * interest case that otherwise falls through to a generic placeholder.
 *
 * Pure and side-effect free, so it is trivially unit-testable and safe to call
 * inside the transaction conversion fallback chain.
 *
 * Precedence (most specific first):
 *   1. MCC (merchant_category_code) — identifies the merchant kind for a card
 *      purchase. Already trusted for auto-categorization
 *      (lib/bookkeeping/mapping-engine.ts).
 *   2. ISO 20022 bank_transaction_code Domain/Family (e.g. "PMNT/CCRD").
 *   3. Keyword scan over the (often proprietary, non-normalized) code strings.
 *   4. Bare "PMNT" domain with no recognized family → direction-based generic.
 *
 * Returns null when nothing is recognized — the caller then falls through to
 * its own final fallback (the ingest boundary normalizes any leftover empty /
 * 'Unknown' value to 'Okänd transaktion').
 *
 * The mapping tables are intentionally small starters. ASPSP coverage of these
 * codes varies and proprietary formats differ per bank — extend the tables
 * against real archived `psd2-response_*.json` samples as they surface.
 */

export interface TransactionLabelInput {
  /** ISO 20022 bank transaction code, e.g. "PMNT-CCRD-POSD" or "PMNT/RCDT". */
  bankTransactionCode?: string | null
  /** ASPSP-proprietary code (free-form, varies per bank). */
  proprietaryBankTransactionCode?: string | null
  /** Merchant category code (card transactions). */
  mcc?: string | number | null
  /** CRDT (money in) vs DBIT (money out) — used only for the bare-domain case. */
  isCredit?: boolean
}

// ISO 20022 External Bank Transaction Codes, keyed by `DOMAIN/FAMILY`.
const ISO20022_LABELS: Record<string, string> = {
  'PMNT/RCDT': 'Inbetalning', // ReceivedCreditTransfers
  'PMNT/ICDT': 'Betalning', // IssuedCreditTransfers
  'PMNT/CCRD': 'Kortköp', // CustomerCardTransactions
  'PMNT/MCRD': 'Kortköp', // MerchantCardTransactions
  'PMNT/RDDT': 'Autogiro', // ReceivedDirectDebits
  'PMNT/IDDT': 'Autogiro', // IssuedDirectDebits
  'PMNT/CWDL': 'Uttag', // CashWithdrawal
  'PMNT/CAJT': 'Justering', // CashAdjustments
}

// MCC → coarse Swedish label. Tiny starter set.
const MCC_LABELS: Record<string, string> = {
  '6011': 'Uttag', // ATM / automated cash disbursements
  '5411': 'Inköp dagligvaror', // Grocery stores, supermarkets
}

// Keyword → label, scanned over the raw (incl. proprietary) code strings as a
// last resort before null. Covers banks that send free-form codes, not ISO.
const KEYWORD_LABELS: Array<[RegExp, string]> = [
  [/INTRST|INTEREST|RÄNTA|RANTA/i, 'Ränta'],
  [/\bFEE\b|CHRG|CHARGE|AVGIFT/i, 'Avgift'],
  [/ATM|CASH.?WDL|WITHDRAW|UTTAG/i, 'Uttag'],
  [/\bCARD\b|KORT|\bPOS\b/i, 'Kortköp'],
  [/SALA|SALARY|\bLÖN\b|\bLON\b/i, 'Lön'],
]

export function deriveTransactionLabel(input: TransactionLabelInput): string | null {
  // 1. MCC — most specific signal for card purchases.
  const mcc = input.mcc != null ? String(input.mcc).trim() : ''
  if (mcc && MCC_LABELS[mcc]) return MCC_LABELS[mcc]

  const codes = [input.bankTransactionCode, input.proprietaryBankTransactionCode].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0,
  )

  // 2. ISO 20022 Domain/Family from the structured code.
  for (const raw of codes) {
    const parts = raw.toUpperCase().split(/[/\-_.\s]+/).filter(Boolean)
    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`
      if (ISO20022_LABELS[key]) return ISO20022_LABELS[key]
    }
  }

  // 3. Keyword scan over the raw code strings (covers proprietary formats).
  for (const raw of codes) {
    for (const [re, label] of KEYWORD_LABELS) {
      if (re.test(raw)) return label
    }
  }

  // 4. Bare "PMNT" domain with no recognized family → direction-based generic.
  if (input.isCredit != null) {
    for (const raw of codes) {
      const domain = raw.toUpperCase().split(/[/\-_.\s]+/)[0]
      if (domain === 'PMNT') return input.isCredit ? 'Inbetalning' : 'Betalning'
    }
  }

  return null
}
