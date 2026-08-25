/**
 * Proposed-kontering line computation, shared by the proposal preview and the
 * "Andra rader" hand-off into the manual booking dialog.
 *
 * `computeProposalLines()` is the single source of what a proposed booking
 * (AI suggestion, static template, counterparty template with or without a
 * line pattern) looks like: JournalEntryPreview renders exactly these lines,
 * and `proposalLinesToFormLines()` converts the same lines into the
 * JournalEntryForm prefill shape so what the user saw is what they edit.
 *
 * ENGINE PARITY IS THE CONTRACT. Because the prefill is bookable, every
 * branch here must reproduce, to the ore, what the corresponding engine path
 * books for the same proposal:
 *
 *   - category branch      -> buildMappingResultFromCategory (category-mapping.ts)
 *   - static template      -> buildMappingResultFromTemplate (booking-templates.ts)
 *   - legacy counterparty  -> buildMappingResultFromCounterpartyTemplate's
 *                             legacy single-pair path (counterparty-templates.ts)
 *   - line pattern         -> buildMultiLineMappingResult (counterparty-templates.ts)
 *   - line assembly/nets   -> buildTransactionEntryLines (transaction-entries.ts)
 *
 * That is why VAT is single-rounded and the net leg is ALWAYS gross minus the
 * rounded VAT (never independently rounded: at 12% both halves round up for
 * gross = 14 mod 28 ore and the entry goes off by 1 ore), why the fiktiv-moms
 * pair uses the engine's plain rounding (roundOre's EPSILON nudge diverges at
 * exact-half floats like 8.62 * 0.25), and why sign-mismatched counterparty
 * matches are mirrored exactly as the server mirrors them.
 *
 * The resulting booking still goes through JournalEntryForm's normal manual
 * validation and the bookkeeping engine: nothing here writes to the ledger.
 */

import { getVatRate } from '@/lib/bookkeeping/vat-entries'
import { getCategoryAccountMapping } from '@/lib/bookkeeping/category-mapping'
import { buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { TransactionCategory, VatTreatment, EntityType, LinePatternEntry } from '@/types'

/**
 * The engine's ore rounding, byte-identical to the Math.round(x*100)/100 the
 * booking paths above use. Deliberately NOT roundOre(): its Number.EPSILON
 * nudge rounds exact-half floats (8.62 * 0.25 = 2.155) up where the engine
 * rounds down, and a prefill that differs from the engine by 1 ore is a
 * refuted bug, not an improvement. Do not "fix" this to roundOre.
 */
function engineRound(n: number): number {
  return Math.round(n * 100) / 100
}

export interface ProposalLine {
  side: 'debet' | 'kredit'
  account: string
  amount: number
  /**
   * True for the bank/settlement leg (the money side). The prefill stamps
   * currency metadata on this leg, and swaps in the transaction's resolved
   * cash account ONLY when the leg is the literal default '1930': the same
   * contract as the engine's applySettlementAccount (mapping-engine.ts),
   * which never rewrites a learned non-1930 money account.
   */
  settlement?: boolean
}

export interface ProposalLinesInput {
  amount: number
  /**
   * SEK-equivalent of `amount` for foreign-currency transactions. When set,
   * all line calculations use this value: the verifikation must always be in
   * SEK regardless of the source currency. Falls back to `amount` when
   * omitted (i.e. SEK transactions).
   */
  amountSek?: number
  category?: TransactionCategory
  /**
   * Explicit VAT treatment. Pass the WIRE value (after resolveExplicitVat):
   * an undefined lets the mapping derive the category default, 'exempt'
   * books no VAT. 'none' is tolerated and collapses to undefined for
   * backward safety, but callers should resolve it first: the raw UI 'none'
   * is ambiguous (seeded default vs explicit no-VAT deviation) and passing
   * it unresolved previews VAT the confirm path would never book.
   */
  vatTreatment?: VatTreatment | 'none'
  accountOverride?: string
  entityType?: EntityType
  /**
   * For template-based bookings: overrides category mapping. Callers must
   * pass the entity-resolved accounts (debit_account_ab/credit_account_ab
   * for aktiebolag), mirroring buildMappingResultFromTemplate.
   */
  templateDebitAccount?: string
  templateCreditAccount?: string
  templateVatRate?: number
  templateVatTreatment?: VatTreatment | null
  templateSupplierType?: 'eu_business' | 'non_eu_business' | 'swedish_business'
  /**
   * Legacy single-pair counterparty template (learned pair, no line_pattern):
   * routes the template accounts through the engine's legacy counterparty
   * semantics instead of the static-template ones: VAT from
   * templateVatTreatment on EXPENSES only (incl. the 2645/2614 fiktiv-moms
   * pair for reverse charge, without the basbelopp pair the static path
   * emits), income booked gross without VAT legs, and sign-mismatched
   * matches mirrored. templateVatRate is ignored in this mode.
   */
  counterpartyLegacy?: boolean
  /** For multi-line counterparty template bookings */
  linePattern?: LinePatternEntry[]
  settlementAccount?: string
}

type LearnedDirection = 'expense' | 'income' | 'unknown'

/**
 * Settlement-account predicate, mirroring the private isSettlementAccount in
 * counterparty-templates.ts (bank/cash 19xx, receivables 1510, payables 2440,
 * credit card 2890). Keep the two in sync.
 */
function isSettlementAccount(account: string): boolean {
  return account.startsWith('19') || account === '1510' || account === '2440' || account === '2890'
}

/** Mirrors legacyTemplateDirection in counterparty-templates.ts. */
function legacyDirection(debitAccount: string, creditAccount: string): LearnedDirection {
  const debitSettles = isSettlementAccount(debitAccount)
  const creditSettles = isSettlementAccount(creditAccount)
  if (creditSettles && !debitSettles) return 'expense'
  if (debitSettles && !creditSettles) return 'income'
  return 'unknown'
}

/** Mirrors patternDirection in counterparty-templates.ts. */
function patternDirection(pattern: LinePatternEntry[]): LearnedDirection {
  const business = pattern.filter((e) => e.type === 'business')
  if (business.length === 0) return 'unknown'
  const debitCount = business.filter((b) => b.side === 'debit').length
  if (debitCount === business.length) return 'expense'
  if (debitCount === 0) return 'income'
  return 'unknown'
}

/**
 * Resolve a static template's accounts for the company's entity type: the
 * same substitution buildMappingResultFromTemplate performs before booking.
 * Exposed so the proposal dialog resolves the accounts it shows and hands
 * over, instead of previewing EF accounts to an aktiebolag.
 */
export function resolveTemplateAccountsForEntity(
  template: {
    debit_account?: string
    credit_account?: string
    debit_account_ab?: string
    credit_account_ab?: string
  },
  entityType: EntityType | undefined,
): { debitAccount?: string; creditAccount?: string } {
  if (entityType === 'aktiebolag') {
    return {
      debitAccount: template.debit_account_ab ?? template.debit_account,
      creditAccount: template.credit_account_ab ?? template.credit_account,
    }
  }
  return { debitAccount: template.debit_account, creditAccount: template.credit_account }
}

/**
 * Compute the concrete verifikation lines a proposal amounts to: what the
 * engine will book for this proposal, expressed as display/prefill lines.
 */
export function computeProposalLines(input: ProposalLinesInput): ProposalLine[] {
  const {
    amount,
    amountSek,
    category,
    vatTreatment,
    accountOverride,
    entityType = 'enskild_firma',
    templateDebitAccount,
    templateCreditAccount,
    templateVatRate,
    templateVatTreatment,
    templateSupplierType,
    counterpartyLegacy,
    linePattern,
    settlementAccount = '1930',
  } = input

  const result: ProposalLine[] = []
  // Use SEK-equivalent when provided; sign comes from `amount` (which
  // distinguishes income vs expense) but magnitude always comes from SEK.
  const absAmount = Math.abs(amountSek ?? amount)
  const isIncome = amount > 0

  // ---- Multi-line counterparty template (buildMultiLineMappingResult) ----
  if (linePattern && linePattern.length > 0) {
    // Sign mismatch (refund/repayment): the engine flips every learned side
    // so the mirrored entry reduces what the original pattern built up.
    const learned = patternDirection(linePattern)
    const mirror =
      (learned === 'expense' && isIncome) || (learned === 'income' && !isIncome)
    const side = (s: 'debit' | 'credit'): 'debet' | 'kredit' => {
      const effective = mirror ? (s === 'debit' ? 'credit' : 'debit') : s
      return effective === 'debit' ? 'debet' : 'kredit'
    }

    // Settlement line: gross on the bank side of the transaction's sign.
    result.push({
      side: isIncome ? 'debet' : 'kredit',
      account: settlementAccount,
      amount: absAmount,
      settlement: true,
    })

    // VAT lines first (from rate, exact)
    let totalVat = 0
    for (const entry of linePattern) {
      if (entry.type === 'vat' && entry.vat_rate) {
        const vatAmt = engineRound(absAmount * entry.vat_rate / (1 + entry.vat_rate))
        totalVat += vatAmt
        result.push({ side: side(entry.side), account: entry.account, amount: vatAmt })
      }
    }

    // Business/tax lines (from ratio against non-VAT amount)
    const nonVatAmt = engineRound(absAmount - totalVat)
    let allocated = 0
    for (const entry of linePattern) {
      if ((entry.type === 'business' || entry.type === 'tax') && entry.ratio !== undefined) {
        const amt = engineRound(nonVatAmt * entry.ratio)
        allocated += amt
        result.push({ side: side(entry.side), account: entry.account, amount: amt })
      }
    }

    // Rounding difference to 3740
    const totalAllocated = engineRound(totalVat + allocated)
    const diff = engineRound(absAmount - totalAllocated)
    if (diff !== 0) {
      const businessSide = linePattern.find(e => e.type === 'business')?.side ?? 'credit'
      result.push({ side: side(businessSide), account: '3740', amount: Math.abs(diff) })
    }

    return result
  }

  // ---- Legacy single-pair counterparty template ----
  // Mirrors buildMappingResultFromCounterpartyTemplate's legacy path plus
  // buildTransactionEntryLines' net assembly: VAT legs on expenses only
  // (reverse charge = the 2645/2614 pair alone, no basbelopp: a learned
  // voucher that HAD basbelopp lines would have become a line_pattern), and
  // sign mismatches mirrored via buildLegacyMismatchResult.
  if (counterpartyLegacy && templateDebitAccount && templateCreditAccount) {
    const treatment = templateVatTreatment ?? null
    const learned = legacyDirection(templateDebitAccount, templateCreditAccount)
    const mismatch =
      (learned === 'expense' && isIncome) || (learned === 'income' && !isIncome)

    if (!mismatch) {
      if (!isIncome) {
        // Expense: net business leg + VAT legs + gross settlement credit.
        if (treatment === 'reverse_charge') {
          const rcVatAmt = engineRound(absAmount * 0.25)
          result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount })
          result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount, settlement: true })
          result.push({ side: 'debet', account: '2645', amount: rcVatAmt })
          result.push({ side: 'kredit', account: '2614', amount: rcVatAmt })
        } else {
          const vatRate = treatment ? getVatRate(treatment) : 0
          const vatAmt = vatRate > 0 ? engineRound(absAmount * vatRate / (1 + vatRate)) : 0
          const netAmt = vatAmt > 0 ? engineRound(absAmount - vatAmt) : absAmount
          result.push({ side: 'debet', account: templateDebitAccount, amount: netAmt })
          if (vatAmt > 0) {
            result.push({ side: 'debet', account: '2641', amount: vatAmt })
          }
          result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount, settlement: true })
        }
      } else {
        // Income: the legacy path emits no VAT lines for income (VAT is
        // gated on isExpense server-side), so gross on both legs.
        result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount, settlement: true })
        result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount })
      }
      return result
    }

    // Sign mismatch: accounts swap sides (buildLegacyMismatchResult).
    if (isIncome) {
      // Refund of an expense-learned pair: settle debit against the bank,
      // reduce the business account, mirror the VAT legs.
      if (treatment === 'reverse_charge') {
        const rcVatAmt = engineRound(absAmount * 0.25)
        result.push({ side: 'debet', account: templateCreditAccount, amount: absAmount, settlement: true })
        result.push({ side: 'kredit', account: templateDebitAccount, amount: absAmount })
        result.push({ side: 'kredit', account: '2645', amount: rcVatAmt })
        result.push({ side: 'debet', account: '2614', amount: rcVatAmt })
      } else {
        const vatRate = treatment ? getVatRate(treatment) : 0
        const vatAmt = vatRate > 0 ? engineRound(absAmount * vatRate / (1 + vatRate)) : 0
        const netAmt = vatAmt > 0 ? engineRound(absAmount - vatAmt) : absAmount
        result.push({ side: 'debet', account: templateCreditAccount, amount: absAmount, settlement: true })
        result.push({ side: 'kredit', account: templateDebitAccount, amount: netAmt })
        if (vatAmt > 0) {
          result.push({ side: 'kredit', account: '2641', amount: vatAmt })
        }
      }
    } else {
      // Outgoing repayment against an income-learned pair: gross both ways,
      // no VAT legs (server emits VAT only for !isExpense mismatches).
      result.push({ side: 'debet', account: templateCreditAccount, amount: absAmount })
      result.push({ side: 'kredit', account: templateDebitAccount, amount: absAmount, settlement: true })
    }
    return result
  }

  // ---- Static template (buildMappingResultFromTemplate) ----
  if (templateDebitAccount && templateCreditAccount) {
    const vatRate = templateVatRate ?? 0
    // Single-rounded VAT, net by subtraction: the engine computes the VAT leg
    // once (generateInputVatLine / the output-VAT branch) and derives the net
    // as gross minus that VAT (transaction-entries.ts). Independently rounding
    // net and VAT (the old extractNet/extractVat pair) goes off by 1 ore at
    // 12% whenever gross = 14 mod 28 ore.
    const vatAmt = vatRate > 0 ? engineRound(absAmount * vatRate / (1 + vatRate)) : 0
    const netAmt = vatAmt > 0 ? engineRound(absAmount - vatAmt) : absAmount
    const isReverseCharge = templateVatTreatment === 'reverse_charge' && !isIncome

    if (isIncome) {
      // Income: debit bank gross, credit revenue net, credit output VAT
      result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount, settlement: true })
      result.push({ side: 'kredit', account: templateCreditAccount, amount: netAmt })
      if (vatAmt > 0) {
        // Map rate -> output VAT account (BAS 2611/2621/2631)
        const outputVatAccount = vatRate === 0.06 ? '2631' : vatRate === 0.12 ? '2621' : '2611'
        result.push({ side: 'kredit', account: outputVatAccount, amount: vatAmt })
      }
    } else if (isReverseCharge) {
      // Expense with reverse charge: full reverse-charge verifikation
      // (must match engine output in buildMappingResultFromTemplate).
      const rcRate = 0.25
      const rcVatAmt = engineRound(absAmount * rcRate)
      const supplierType = templateSupplierType ?? 'eu_business'
      const isDomestic = supplierType === 'swedish_business'

      // Expense gross + bank
      result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount })
      result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount, settlement: true })

      // Fiktiv moms pair: 2645 (or 2647 domestic) / 2614
      result.push({ side: 'debet', account: isDomestic ? '2647' : '2645', amount: rcVatAmt })
      result.push({ side: 'kredit', account: '2614', amount: rcVatAmt })

      // Basbelopp pair: 44xx|45xx / 4598, populates rutor 20-24.
      // Skip if the debit account is already a basis account.
      if (!/^4[45]\d{2}$/.test(templateDebitAccount)) {
        const basisAccount =
          supplierType === 'eu_business' ? '4535'
          : supplierType === 'non_eu_business' ? '4531'
          : '4425'
        result.push({ side: 'debet', account: basisAccount, amount: absAmount })
        result.push({ side: 'kredit', account: '4598', amount: absAmount })
      }
    } else {
      // Expense: debit expense net + input VAT, credit bank gross
      result.push({ side: 'debet', account: templateDebitAccount, amount: netAmt })
      if (vatAmt > 0) {
        result.push({ side: 'debet', account: '2641', amount: vatAmt })
      }
      result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount, settlement: true })
    }
    return result
  }

  // ---- Category-based (incl. AI suggestion) ----
  if (!category) return result

  const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
  const mapping = getCategoryAccountMapping(category, amount, category !== 'private', entityType, resolvedVat)

  const debitAccount = accountOverride && amount < 0 ? accountOverride : mapping.debitAccount
  const creditAccount = accountOverride && amount > 0 ? accountOverride : mapping.creditAccount

  const treatment = mapping.vatTreatment as VatTreatment | null
  const vatRate = treatment ? getVatRate(treatment) : 0
  // buildMappingResultFromCategory computes the VAT leg with roundOre and the
  // net as gross minus that leg (transaction-entries.ts).
  const vatAmt = vatRate > 0 ? roundOre(absAmount * vatRate / (1 + vatRate)) : 0

  if (amount < 0) {
    // Expense: Debit expense + VAT, Credit bank. The net leg carries the full
    // gross when no VAT line is emitted (matches the engine's no-VAT branch).
    const hasVatLine = vatAmt > 0 && !!mapping.vatDebitAccount
    const netAmt = hasVatLine ? engineRound(absAmount - vatAmt) : absAmount
    result.push({ side: 'debet', account: debitAccount, amount: netAmt })
    if (hasVatLine && mapping.vatDebitAccount) {
      result.push({ side: 'debet', account: mapping.vatDebitAccount, amount: vatAmt })
    }
    result.push({ side: 'kredit', account: creditAccount, amount: absAmount, settlement: true })
  } else {
    // Income: Debit bank, Credit revenue + VAT
    const hasVatLine = vatAmt > 0 && !!mapping.vatCreditAccount
    const netAmt = hasVatLine ? engineRound(absAmount - vatAmt) : absAmount
    result.push({ side: 'debet', account: debitAccount, amount: absAmount, settlement: true })
    if (hasVatLine && mapping.vatCreditAccount) {
      result.push({ side: 'kredit', account: mapping.vatCreditAccount, amount: vatAmt })
    }
    result.push({ side: 'kredit', account: creditAccount, amount: netAmt })
  }

  // Reverse charge: add offsetting lines (generateReverseChargeLines)
  if (treatment === 'reverse_charge' && amount < 0) {
    const rcVatAmt = engineRound(absAmount * 0.25)
    result.push({ side: 'debet', account: '2645', amount: rcVatAmt })
    result.push({ side: 'kredit', account: '2614', amount: rcVatAmt })
  }

  return result
}

/**
 * Convert computed proposal lines into JournalEntryForm prefill lines: the
 * same hand-off shape buildInitialLinesFromTemplate produces for library
 * templates. Amounts arrive already ore-rounded from computeProposalLines;
 * toFixed(2) here only formats the input-field string (same pattern as
 * applyTemplate / buildInitialLines), it is not money math.
 */
export function proposalLinesToFormLines(
  lines: ProposalLine[],
  opts: {
    /**
     * Resolved cash account: replaces the settlement leg's account ONLY when
     * that leg is the literal default '1930', mirroring the engine's
     * applySettlementAccount. A learned non-1930 money leg (1510, 2440,
     * 2890, another 19xx) is authoritative and is never rewritten.
     */
    settlementAccount?: string
    currency?: string | null
    /** Foreign-currency amount of the transaction (absolute). */
    foreignAmount?: number | null
    exchangeRate?: number | null
  } = {},
): FormLine[] {
  const currencyMeta = buildCurrencyMetadata(opts.currency, opts.foreignAmount, opts.exchangeRate)

  return lines.map((line) => {
    const amount = roundOre(line.amount)
    const amountStr = amount.toFixed(2)
    const isSettlement = line.settlement === true
    const swapAccount = isSettlement && line.account === '1930' && !!opts.settlementAccount
    return {
      account_number: swapAccount && opts.settlementAccount ? opts.settlementAccount : line.account,
      debit_amount: line.side === 'debet' ? amountStr : '',
      credit_amount: line.side === 'kredit' ? amountStr : '',
      line_description: '',
      // Currency metadata belongs on the money leg only, mirroring
      // buildTransactionEntryLines' settlement handling.
      ...(isSettlement ? currencyMeta : {}),
    }
  })
}
