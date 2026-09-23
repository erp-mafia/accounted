import type { MappingResult, Transaction, VatTreatment } from '@/types'
import { roundOre } from '@/lib/money'
import { resolveSekAmount } from './currency-utils'
import { getVatRate } from './vat-entries'

/**
 * Replace the rate-based VAT line of a template booking with the underlag's
 * actual moms. A clean 25 % receipt gives the same figure either way; one
 * with dricks, mixed rates or öresavrundning does not, and the document is
 * the truth (ML 8 kap. 17 §: the deduction follows the invoice).
 *
 * Same rules and bounds as buildMappingResultFromCategory's
 * vatAmountOverride: only on a rate-based treatment, positive, at most the
 * 25 % share of the gross. vatAmount is in the transaction's currency and
 * the line is SEK, scaled by the same ratio the gross resolved at.
 */
export function applyVatAmountOverride(
  result: MappingResult,
  transaction: Transaction,
  treatment: VatTreatment | null | undefined,
  vatAmount: number,
): MappingResult {
  if (!treatment || treatment === 'reverse_charge' || getVatRate(treatment) <= 0) {
    throw new Error(
      `vat_amount cannot be combined with vat_treatment "${treatment ?? 'none'}": ` +
        'it only overrides a rate-based VAT line (standard_25, reduced_12, reduced_6).',
    )
  }
  if (typeof vatAmount !== 'number' || !Number.isFinite(vatAmount) || vatAmount <= 0) {
    throw new Error(`vat_amount must be a positive number, got ${vatAmount}.`)
  }
  const absAmount = Math.abs(transaction.amount)
  const maxVat = roundOre((absAmount * 0.25) / 1.25)
  if (vatAmount > maxVat) {
    throw new Error(
      `vat_amount ${vatAmount} exceeds the maximum possible Swedish VAT on ${absAmount} (${maxVat} at 25%). ` +
        'Check the underlag: the override must be the document\'s actual moms.',
    )
  }
  const absSek = Math.abs(
    resolveSekAmount(transaction.amount, transaction.amount_sek, transaction.currency, transaction.exchange_rate),
  )
  const sekVat = roundOre(vatAmount * (absSek / absAmount))
  const isExpense = transaction.amount < 0
  const idx = result.vat_lines.findIndex((l) =>
    isExpense
      ? l.account_number.startsWith('264') && l.debit_amount > 0
      : /^26[123]/.test(l.account_number) && l.credit_amount > 0,
  )
  if (idx < 0) {
    throw new Error('vat_amount needs a rate-based VAT line to replace, and this booking has none.')
  }
  const vat_lines = result.vat_lines.slice()
  vat_lines[idx] = {
    ...vat_lines[idx],
    debit_amount: isExpense ? sekVat : 0,
    credit_amount: isExpense ? 0 : sekVat,
    description: isExpense ? 'Ingående moms (enligt underlag)' : 'Utgående moms (enligt underlag)',
  }
  return { ...result, vat_lines }
}
