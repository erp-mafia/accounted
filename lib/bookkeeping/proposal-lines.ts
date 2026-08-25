/**
 * Proposed-kontering line computation, shared by the proposal preview and the
 * "Andra rader" hand-off into the manual booking dialog.
 *
 * `computeProposalLines()` is the single source of what a proposed booking
 * (AI suggestion, static template, counterparty template with or without a
 * line pattern) looks like: JournalEntryPreview renders exactly these lines,
 * and `proposalLinesToFormLines()` converts the same lines into the
 * JournalEntryForm prefill shape so what the user saw is what they edit.
 * Keeping both in one module prevents preview and prefill from drifting.
 *
 * The resulting booking still goes through JournalEntryForm's normal manual
 * validation and the bookkeeping engine: nothing here writes to the ledger.
 */

import { getVatRate, extractVatAmount, extractNetAmount } from '@/lib/bookkeeping/vat-entries'
import { getCategoryAccountMapping } from '@/lib/bookkeeping/category-mapping'
import { buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { TransactionCategory, VatTreatment, EntityType, LinePatternEntry } from '@/types'

export interface ProposalLine {
  side: 'debet' | 'kredit'
  account: string
  amount: number
  /**
   * True for the bank/settlement leg. TransactionBookingDialog swaps in the
   * transaction's resolved cash account and stamps currency metadata on this
   * leg, mirroring what buildInitialLinesFromTemplate does for library
   * templates' settlement lines.
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
  vatTreatment?: VatTreatment | 'none'
  accountOverride?: string
  entityType?: EntityType
  /** For template-based bookings: overrides category mapping */
  templateDebitAccount?: string
  templateCreditAccount?: string
  templateVatRate?: number
  templateVatTreatment?: VatTreatment | null
  templateSupplierType?: 'eu_business' | 'non_eu_business' | 'swedish_business'
  /** For multi-line counterparty template bookings */
  linePattern?: LinePatternEntry[]
  settlementAccount?: string
}

/**
 * Compute the concrete verifikation lines a proposal amounts to. Extracted
 * verbatim from JournalEntryPreview so the preview and the editable prefill
 * are guaranteed to agree line for line.
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
    linePattern,
    settlementAccount = '1930',
  } = input

  const result: ProposalLine[] = []
  // Use SEK-equivalent when provided; sign comes from `amount` (which
  // distinguishes income vs expense) but magnitude always comes from SEK.
  const absAmount = Math.abs(amountSek ?? amount)

  // Multi-line counterparty template
  if (linePattern && linePattern.length > 0) {
    const isIncome = amount > 0
    const settlementSide = isIncome ? 'debet' : 'kredit'

    // Settlement line
    result.push({ side: settlementSide, account: settlementAccount, amount: absAmount, settlement: true })

    // VAT lines first (from rate)
    let totalVat = 0
    for (const entry of linePattern) {
      if (entry.type === 'vat' && entry.vat_rate) {
        const vatAmt = roundOre(absAmount * entry.vat_rate / (1 + entry.vat_rate))
        totalVat += vatAmt
        result.push({ side: entry.side === 'debit' ? 'debet' : 'kredit', account: entry.account, amount: vatAmt })
      }
    }

    // Business/tax lines (from ratio against non-VAT amount)
    const nonVatAmt = roundOre(absAmount - totalVat)
    let allocated = 0
    const ratioEntries = linePattern.filter(e => e.ratio !== undefined)
    for (const entry of ratioEntries) {
      const amt = roundOre(nonVatAmt * (entry.ratio ?? 0))
      allocated += amt
      result.push({ side: entry.side === 'debit' ? 'debet' : 'kredit', account: entry.account, amount: amt })
    }

    // Rounding difference to 3740
    const totalAllocated = roundOre(totalVat + allocated)
    const diff = roundOre(absAmount - totalAllocated)
    if (diff !== 0) {
      const businessSide = linePattern.find(e => e.type === 'business')?.side ?? 'credit'
      result.push({ side: businessSide === 'debit' ? 'debet' : 'kredit', account: '3740', amount: Math.abs(diff) })
    }

    return result
  }

  // Template-based (static review template or legacy counterparty pair)
  if (templateDebitAccount && templateCreditAccount) {
    const vatRate = templateVatRate ?? 0
    const vatAmt = extractVatAmount(absAmount, vatRate)
    const netAmt = extractNetAmount(absAmount, vatRate)
    const isIncome = amount > 0
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
      const rcVatAmt = roundOre(absAmount * rcRate)
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

  // Category-based (incl. AI suggestion, which applies account + VAT overrides)
  if (!category) return result

  const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
  const mapping = getCategoryAccountMapping(category, amount, category !== 'private', entityType, resolvedVat)

  const debitAccount = accountOverride && amount < 0 ? accountOverride : mapping.debitAccount
  const creditAccount = accountOverride && amount > 0 ? accountOverride : mapping.creditAccount

  const treatment = mapping.vatTreatment as VatTreatment | null
  const vatRate = treatment ? getVatRate(treatment) : 0
  const vatAmt = vatRate > 0 ? extractVatAmount(absAmount, vatRate) : 0
  const netAmt = vatRate > 0 ? extractNetAmount(absAmount, vatRate) : absAmount

  if (amount < 0) {
    // Expense: Debit expense + VAT, Credit bank
    result.push({ side: 'debet', account: debitAccount, amount: netAmt })
    if (vatAmt > 0 && mapping.vatDebitAccount) {
      result.push({ side: 'debet', account: mapping.vatDebitAccount, amount: vatAmt })
    }
    result.push({ side: 'kredit', account: creditAccount, amount: absAmount, settlement: true })
  } else {
    // Income: Debit bank, Credit revenue + VAT
    result.push({ side: 'debet', account: debitAccount, amount: absAmount, settlement: true })
    if (vatAmt > 0 && mapping.vatCreditAccount) {
      result.push({ side: 'kredit', account: mapping.vatCreditAccount, amount: vatAmt })
    }
    result.push({ side: 'kredit', account: creditAccount, amount: netAmt })
  }

  // Reverse charge: add offsetting lines
  if (treatment === 'reverse_charge' && amount < 0) {
    const rcVatAmt = roundOre(absAmount * 0.25)
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
    /** Resolved cash account: replaces the settlement leg's account. */
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
    return {
      account_number: isSettlement && opts.settlementAccount ? opts.settlementAccount : line.account,
      debit_amount: line.side === 'debet' ? amountStr : '',
      credit_amount: line.side === 'kredit' ? amountStr : '',
      line_description: '',
      // Currency metadata belongs on the bank leg only, mirroring
      // buildInitialLinesFromTemplate's settlement handling.
      ...(isSettlement ? currencyMeta : {}),
    }
  })
}
