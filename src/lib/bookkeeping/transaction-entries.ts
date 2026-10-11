import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveCashAccountVoucherSeries } from './cash-account-voucher-series'
import { bankBookingContext } from './bank-booking-context'
import { resolveSekAmountOrNull, buildCurrencyMetadata } from './currency-utils'
import { coerceDimensionsBag, mergeDimensionBags } from './dimension-resolver'
import { extractNetAmount, extractVatAmount } from './vat-entries'
import { roundOre } from '@/lib/money'
import { InvalidMappingResultError, TransactionMissingSekValueError } from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  MappingResult,
  Transaction,
  VatJournalLine,
} from '@/types'

const log = createLogger('transaction-entries')

interface EarliestFiscalPeriodRow {
  id: string
  period_start: string
  is_closed: boolean
  locked_at: string | null
}

/**
 * The company's earliest fiscal period (full row, closed or not). Used by the
 * pre-FY clamp in createTransactionJournalEntry below to tell "this date
 * predates the company's first rakenskapsar" apart from an interior gap.
 */
async function findEarliestFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
): Promise<EarliestFiscalPeriodRow | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, is_closed, locked_at')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
    .limit(1)

  if (error || !data || data.length === 0) return null
  return data[0] as EarliestFiscalPeriodRow
}

/**
 * What the moms lines take out of the business line: their net on the
 * business line's own side. Ingående moms on a purchase and utgående moms
 * taken back on a refund to a customer are debits beside a debited business
 * line; utgående moms on a sale and ingående moms taken back on a refund from
 * a supplier are credits beside a credited one. A reverse-charge set has legs
 * on both sides and nets to zero, so the business line keeps the gross.
 */
function vatBesideBusinessLine(vatLines: VatJournalLine[], businessSide: 'debit' | 'credit'): number {
  return roundOre(vatLines.reduce(
    (sum, l) => sum + (businessSide === 'debit' ? l.debit_amount - l.credit_amount : l.credit_amount - l.debit_amount),
    0,
  ))
}

/**
 * Build the journal entry lines for a bank transaction from a mapping engine
 * result. Single source of truth for the gross→net split: the expense account
 * gets the amount net of deductible input VAT while the bank line stays gross.
 * Used both by createTransactionJournalEntry (commit) and by the staged
 * categorization preview, so the lines a user approves are the lines posted.
 *
 * Standard expense pattern (domestic purchase with 25% VAT):
 *   Debit  5xxx/6xxx Expense account  [net amount]
 *   Debit  2641 Ingående moms         [VAT amount]
 *   Credit 1930 Företagskonto          [total]
 *
 * Standard expense pattern (no VAT deduction):
 *   Debit  5xxx/6xxx Expense account  [total]
 *   Credit 1930 Företagskonto          [total]
 *
 * Private expense pattern:
 *   Debit  2013 Eget uttag            [total]
 *   Credit 1930 Företagskonto          [total]
 *
 * EU reverse charge purchase pattern:
 *   Debit  5xxx/6xxx Expense account  [total]
 *   Debit  2645 Beräknad ingående moms [fiktiv VAT]
 *   Credit 2614 Utgående moms omvänd   [fiktiv VAT]
 *   Credit 1930 Företagskonto          [total]
 *
 * Income pattern:
 *   Debit  1930 Företagskonto          [total]
 *   Credit 3xxx Revenue account        [total]
 *
 * Refund patterns (a row against its category's direction, see
 * isCategoryReversal in category-mapping.ts): the same accounts on the
 * opposite sides, the bank line still on the side the money moved.
 *   Refund to a customer:    Debit 3xxx [net], Debit 26x1 [VAT], Credit 1930 [total]
 *   Refund from a supplier:  Debit 1930 [total], Credit 5xxx/6xxx [net], Credit 2641 [VAT]
 */
export function buildTransactionEntryLines(
  transaction: Transaction,
  mappingResult: MappingResult,
): CreateJournalEntryLineInput[] {
  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    throw new InvalidMappingResultError(mappingResult.debit_account, mappingResult.credit_account)
  }

  // Strict ladder: a foreign row with neither amount_sek nor exchange_rate has
  // no SEK value, and the lenient resolver would book the foreign number as
  // kronor (100 CAD as 100 kr). Every categorize preview and commit builds its
  // lines here, so refusing here refuses them all.
  const sekAmount = resolveSekAmountOrNull(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  )
  if (sekAmount === null) {
    throw new TransactionMissingSekValueError(transaction.id, transaction.currency, transaction.date)
  }
  const absAmount = Math.abs(sekAmount)
  // Money out. The name is historical: the sign decides only which side the
  // bank line sits on (credit for money out), and the mapping's other account
  // takes the opposite side. So the money-out branches below also book a
  // refund to a customer, and the money-in branches a refund from a supplier.
  const isExpense = transaction.amount < 0
  const isForeign = transaction.currency !== 'SEK'
  const currencyMeta = buildCurrencyMetadata(
    transaction.currency,
    isForeign ? Math.abs(transaction.amount) : undefined,
    transaction.exchange_rate
  )
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: the bag tags the business (expense/revenue) lines only:
  // bank/settlement and VAT lines stay untagged. The private path books to a
  // balance account (2013/2893): never tagged.
  const businessDimensions = coerceDimensionsBag(mappingResult.dimensions)
  // Every single-pair branch books its business line through this helper, so
  // the bag is stamped in one place and no branch can drop it: the VAT-free
  // income branch once did, and the counterparty template then learned a bag
  // the verifikat never carried.
  const businessLine = (
    line: Omit<CreateJournalEntryLineInput, 'dimensions'>,
  ): CreateJournalEntryLineInput => ({ ...line, dimensions: businessDimensions })
  // Multi-line pattern path: every line keeps the pattern's own learned bag,
  // and the lines the pattern marks as business also take the caller's
  // explicit bag, which wins per key (on this path mappingResult.dimensions
  // can only be that explicit bag: buildMultiLineMappingResult never sets
  // it). VAT, tax and rounding lines are never marked, so they never inherit
  // it.
  const patternLine = (line: VatJournalLine): CreateJournalEntryLineInput => ({
    account_number: line.account_number,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    line_description: line.description || transaction.description,
    dimensions: line.business_line
      ? mergeDimensionBags(coerceDimensionsBag(line.dimensions), businessDimensions)
      : coerceDimensionsBag(line.dimensions),
  })

  if (mappingResult.default_private) {
    // Private expense: use entity-specific account from mappingResult
    lines.push(
      {
        account_number: mappingResult.debit_account,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: `Privat: ${transaction.description}`,
      },
      {
        account_number: mappingResult.credit_account || '1930',
        debit_amount: 0,
        credit_amount: absAmount,
        line_description: transaction.description,
      }
    )
  } else if (mappingResult.all_lines_complete) {
    // Multi-line pattern: vat_lines contains ALL non-settlement lines with correct amounts.
    // Settlement line = full absAmount on the appropriate side.
    const settlementAccount = isExpense
      ? (mappingResult.credit_account || '1930')
      : (mappingResult.debit_account || '1930')

    if (isExpense) {
      // All non-settlement lines (business, VAT, tax, rounding), tagged per
      // line by patternLine above.
      for (const line of mappingResult.vat_lines) {
        lines.push(patternLine(line))
      }
      // Credit bank for full amount
      lines.push({
        account_number: settlementAccount,
        debit_amount: 0,
        credit_amount: absAmount,
        line_description: transaction.description,
        ...(isForeign ? currencyMeta : {}),
      })
    } else {
      // Debit bank for full amount
      lines.push({
        account_number: settlementAccount,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: transaction.description,
        ...(isForeign ? currencyMeta : {}),
      })
      // All non-settlement lines, tagged per line (see patternLine).
      for (const line of mappingResult.vat_lines) {
        lines.push(patternLine(line))
      }
    }
  } else if (isExpense) {
    // Money out: a business expense, or a refund to a customer (legacy single
    // debit/credit path)
    const debitAccount = mappingResult.debit_account
    const creditAccount = mappingResult.credit_account || '1930'

    if (mappingResult.vat_lines.length > 0) {
      // Has VAT handling (reverse charge, input VAT, or output VAT taken back)
      for (const vatLine of mappingResult.vat_lines) {
        lines.push({
          account_number: vatLine.account_number,
          debit_amount: vatLine.debit_amount,
          credit_amount: vatLine.credit_amount,
          line_description: vatLine.description,
        })
      }

      // The business account gets the net amount (total minus the moms beside
      // it): ingående moms on 2641 for a purchase, utgående moms taken back on
      // 26x1 for a refund to a customer. It used to count 2641 alone, which
      // left a refund's 26x1 debit on top of the gross (crm#1136).
      const vatDebit = vatBesideBusinessLine(mappingResult.vat_lines, 'debit')
      // Round to 2 decimal places to avoid floating point issues
      const netAmount = Math.round((absAmount - vatDebit) * 100) / 100

      lines.push(businessLine({
        account_number: debitAccount,
        debit_amount: netAmount,
        credit_amount: 0,
        line_description: transaction.description,
      }))
    } else {
      // No VAT handling - debit full amount to expense account
      lines.push(businessLine({
        account_number: debitAccount,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: transaction.description,
      }))
    }

    // Credit bank account
    lines.push({
      account_number: creditAccount,
      debit_amount: 0,
      credit_amount: absAmount,
      line_description: transaction.description,
      ...(isForeign ? currencyMeta : {}),
    })
  } else {
    // Money in: income, or a refund from a supplier (legacy single
    // debit/credit path)
    const debitAccount = mappingResult.debit_account || '1930'
    const creditAccount = mappingResult.credit_account

    if (mappingResult.vat_lines.length > 0) {
      // Has output VAT. Net the credits against any debit VAT legs: a
      // mirrored reverse-charge refund carries a credit 2645 + debit 2614
      // pair that nets to zero, so the business line keeps the gross amount.
      // Ordinary output-VAT lines are credit-only (debit_amount 0), so the
      // net equals the old credit-sum for every non-RC path.
      const vatCredit = vatBesideBusinessLine(mappingResult.vat_lines, 'credit')
      const netAmount = Math.round((absAmount - vatCredit) * 100) / 100

      // Debit bank for gross amount
      lines.push({
        account_number: debitAccount,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: transaction.description,
        ...(isForeign ? currencyMeta : {}),
      })
      // Credit revenue for net amount
      lines.push(businessLine({
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: netAmount,
        line_description: transaction.description,
      }))
      // Credit output VAT
      for (const vatLine of mappingResult.vat_lines) {
        lines.push({
          account_number: vatLine.account_number,
          debit_amount: vatLine.debit_amount,
          credit_amount: vatLine.credit_amount,
          line_description: vatLine.description,
        })
      }
    } else {
      // No VAT (a company that is not VAT-registered, or VAT-exempt income):
      // simple two-line entry
      lines.push(
        {
          account_number: debitAccount,
          debit_amount: absAmount,
          credit_amount: 0,
          line_description: transaction.description,
          ...(isForeign ? currencyMeta : {}),
        },
        businessLine({
          account_number: creditAccount,
          debit_amount: 0,
          credit_amount: absAmount,
          line_description: transaction.description,
        }),
      )
    }
  }

  return lines
}

/**
 * Create a journal entry from a bank transaction using mapping engine result.
 * Line patterns are documented on buildTransactionEntryLines above.
 */
export async function createTransactionJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transaction: Transaction,
  mappingResult: MappingResult,
  // Optional audit-trail text to append to the verifikation's description.
  // Used by the agent for representation bookings to capture deltagare +
  // syfte directly on the journal entry (SKV's representationsregler /
  // ML 8 kap require the verifikation to document who attended and why).
  notes?: string,
): Promise<JournalEntry | null> {
  // Build lines first — throws InvalidMappingResultError on a broken mapping
  // before any period lookup, preserving the original validation order.
  const lines = buildTransactionEntryLines(transaction, mappingResult)

  let fiscalPeriodId = await findFiscalPeriod(supabase, companyId, transaction.date)
  let entryDate = transaction.date
  let preFyNote: string | null = null

  if (!fiscalPeriodId) {
    // Pre-FY clamp (issue #1825): a bank event dated before the company's
    // first rakenskapsar (typically the aktiekapital deposit paid in before
    // the Bolagsverket registration date) has no covering period, and minting
    // a pre-registration year for it would be legally wrong. The correct
    // booking is on the first fiscal year's first day, with the real event
    // date preserved in the verifikationstext (BFL 5 kap 7 §). The clamp
    // fires ONLY when the date is strictly before the earliest period AND
    // that period is open and unlocked; interior gaps, future dates, and a
    // closed/locked first year keep the old null return.
    const earliest = await findEarliestFiscalPeriod(supabase, companyId)
    if (
      earliest &&
      transaction.date < earliest.period_start &&
      !earliest.is_closed &&
      !earliest.locked_at
    ) {
      fiscalPeriodId = earliest.id
      entryDate = earliest.period_start
      preFyNote = `Affärshändelse ${transaction.date}, bokförd på räkenskapsårets första dag`
    } else {
      log.warn('No open fiscal period found for transaction date:', transaction.date)
      return null
    }
  }

  // Compose the verifikation's description (verifikationstext). journal_entries
  // has no separate notes column: the description IS the BFL audit field, so
  // representation deltagare/syfte etc. belong here. Separate the bank text
  // and the note with a middle dot (never an em-dash: house style), and only
  // append when the note isn't already implied by the bank text.
  const trimmedNotes = notes?.trim()
  const baseDescription = (transaction.description ?? '').trim()
  const extraParts = [trimmedNotes, preFyNote].filter((p): p is string => !!p)
  const composedDescription = extraParts.length > 0
    ? [baseDescription, ...extraParts].filter(Boolean).join(' · ').slice(0, 500)
    : baseDescription

  // The transaction's bank account may carry its own verifikationsserie;
  // undefined lets the engine fall back to the per-source-type default.
  const voucherSeries = await resolveCashAccountVoucherSeries(
    supabase,
    companyId,
    transaction.cash_account_id,
  )

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description: composedDescription,
    source_type: 'bank_transaction',
    source_id: transaction.id,
    bank_booking_context: [bankBookingContext(transaction,
      transaction.amount < 0 ? mappingResult.credit_account! : mappingResult.debit_account!)],
    lines,
    ...(voucherSeries ? { voucher_series: voucherSeries } : {}),
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create a standard domestic expense entry with input VAT deduction
 */
export function buildDomesticExpenseLines(
  amount: number,
  expenseAccount: string,
  description: string,
  vatRate: number = 0.25,
  bankAccount: string = '1930'
): CreateJournalEntryLineInput[] {
  const absAmount = Math.abs(amount)
  const lines: CreateJournalEntryLineInput[] = []

  if (vatRate > 0) {
    const vatAmount = extractVatAmount(absAmount, vatRate)
    const netAmount = extractNetAmount(absAmount, vatRate)

    lines.push(
      {
        account_number: expenseAccount,
        debit_amount: netAmount,
        credit_amount: 0,
        line_description: description,
      },
      {
        account_number: '2641', // Ingående moms
        debit_amount: vatAmount,
        credit_amount: 0,
        line_description: `Ingående moms ${vatRate * 100}%`,
      },
      {
        account_number: bankAccount,
        debit_amount: 0,
        credit_amount: absAmount,
        line_description: description,
      }
    )
  } else {
    lines.push(
      {
        account_number: expenseAccount,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: description,
      },
      {
        account_number: bankAccount,
        debit_amount: 0,
        credit_amount: absAmount,
        line_description: description,
      }
    )
  }

  return lines
}
