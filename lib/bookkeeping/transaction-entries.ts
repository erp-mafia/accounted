import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
import { coerceDimensionsBag } from './dimension-resolver'
import { extractNetAmount, extractVatAmount } from './vat-entries'
import { roundOre } from '@/lib/money'
import { InvalidMappingResultError } from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  MappingResult,
  Transaction,
} from '@/types'

const log = createLogger('transaction-entries')

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
 */
export function buildTransactionEntryLines(
  transaction: Transaction,
  mappingResult: MappingResult,
): CreateJournalEntryLineInput[] {
  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    throw new InvalidMappingResultError(mappingResult.debit_account, mappingResult.credit_account)
  }

  const absAmountSek = Math.abs(resolveSekAmount(
    transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate
  ))
  const absAmount = absAmountSek
  const isExpense = transaction.amount < 0
  const isForeign = transaction.currency !== 'SEK'
  const currencyMeta = buildCurrencyMetadata(
    transaction.currency,
    isForeign ? Math.abs(transaction.amount) : undefined,
    transaction.exchange_rate
  )
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: the bag tags the business (expense/revenue) lines only:
  // bank/settlement and VAT lines stay untagged. In the multi-line template
  // path each pattern line carries its own bag instead (LinePatternEntry).
  // The private path books to a balance account (2013/2893): never tagged.
  const businessDimensions = coerceDimensionsBag(mappingResult.dimensions)

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
      // All non-settlement lines (business, VAT, tax, rounding). Per-line bags
      // are authoritative here: the pattern marks business lines only, so no
      // fallback to the categorize-level bag (it would mis-tag VAT/tax lines).
      for (const line of mappingResult.vat_lines) {
        lines.push({
          account_number: line.account_number,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          line_description: line.description || transaction.description,
          dimensions: coerceDimensionsBag(line.dimensions),
        })
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
      // All non-settlement lines: per-line bags authoritative (see above).
      for (const line of mappingResult.vat_lines) {
        lines.push({
          account_number: line.account_number,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          line_description: line.description || transaction.description,
          dimensions: coerceDimensionsBag(line.dimensions),
        })
      }
    }
  } else if (isExpense) {
    // Business expense (legacy single debit/credit path)
    const debitAccount = mappingResult.debit_account
    const creditAccount = mappingResult.credit_account || '1930'

    if (mappingResult.vat_lines.length > 0) {
      // Has VAT handling (reverse charge or input VAT)
      for (const vatLine of mappingResult.vat_lines) {
        lines.push({
          account_number: vatLine.account_number,
          debit_amount: vatLine.debit_amount,
          credit_amount: vatLine.credit_amount,
          line_description: vatLine.description,
        })
      }

      // Expense account gets the net amount (total minus VAT if applicable)
      const vatDebit = mappingResult.vat_lines
        .filter((l) => l.debit_amount > 0 && l.account_number === '2641')
        .reduce((sum, l) => sum + l.debit_amount, 0)
      // Round to 2 decimal places to avoid floating point issues
      const netAmount = Math.round((absAmount - vatDebit) * 100) / 100

      lines.push({
        account_number: debitAccount,
        debit_amount: netAmount,
        credit_amount: 0,
        line_description: transaction.description,
        dimensions: businessDimensions,
      })
    } else {
      // No VAT handling - debit full amount to expense account
      lines.push({
        account_number: debitAccount,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: transaction.description,
        dimensions: businessDimensions,
      })
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
    // Income (legacy single debit/credit path)
    const debitAccount = mappingResult.debit_account || '1930'
    const creditAccount = mappingResult.credit_account

    if (mappingResult.vat_lines.length > 0) {
      // Has output VAT. Net the credits against any debit VAT legs: a
      // mirrored reverse-charge refund carries a credit 2645 + debit 2614
      // pair that nets to zero, so the business line keeps the gross amount.
      // Ordinary output-VAT lines are credit-only (debit_amount 0), so the
      // net equals the old credit-sum for every non-RC path.
      const vatCredit = roundOre(
        mappingResult.vat_lines.reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
      )
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
      lines.push({
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: netAmount,
        line_description: transaction.description,
        dimensions: businessDimensions,
      })
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
      // No VAT - simple two-line entry
      lines.push(
        {
          account_number: debitAccount,
          debit_amount: absAmount,
          credit_amount: 0,
          line_description: transaction.description,
          ...(isForeign ? currencyMeta : {}),
        },
        {
          account_number: creditAccount,
          debit_amount: 0,
          credit_amount: absAmount,
          line_description: transaction.description,
        }
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

  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, transaction.date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for transaction date:', transaction.date)
    return null
  }

  // Compose the verifikation's description (verifikationstext). journal_entries
  // has no separate notes column: the description IS the BFL audit field, so
  // representation deltagare/syfte etc. belong here. Separate the bank text
  // and the note with a middle dot (never an em-dash: house style), and only
  // append when the note isn't already implied by the bank text.
  const trimmedNotes = notes?.trim()
  const baseDescription = (transaction.description ?? '').trim()
  const composedDescription = trimmedNotes
    ? `${baseDescription} · ${trimmedNotes}`.trim().replace(/^· /, '').slice(0, 500)
    : baseDescription

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: transaction.date,
    description: composedDescription,
    source_type: 'bank_transaction',
    source_id: transaction.id,
    lines,
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
