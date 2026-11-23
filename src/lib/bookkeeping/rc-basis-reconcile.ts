import type { MappingResult, VatJournalLine } from '@/types'
import {
  generateReverseChargePurchaseLines,
  isReverseChargeBasisAccount,
  isReverseChargeVatAccount,
  reverseChargeKindForBasisAccount,
  reverseChargePurchasesOn,
  RC_BASIS_OFFSET_ACCOUNT,
  type ChartVatTreatments,
  type ReverseChargeKind,
} from './vat-entries'
import type { ChartVatTreatmentsLoader } from './chart-vat-treatments'

/**
 * The reverse-charge set of a bank booking, settled against the accounts its
 * cost lines are finally booked on (crm#1096).
 *
 * Every bank-categorization builder (category, mapping rule, booking template,
 * learned counterparty template) books the complete reverse-charge set as for
 * an ordinary cost account, at the builder's rate: the fiktiv moms AND the
 * 44xx|45xx / 4598 basis pair for rutor 20-24. Whether that is right depends
 * on the company's chart, which the builders cannot read, and on the account
 * the cost line lands on, which an account_override still changes after them.
 * So it is decided here, last, by the declaration's own rule
 * (reverseChargePurchasesOn): a cost line on an account that reports ruta
 * 20-24 itself (a BAS basis account such as 4535, or a class 4-6 account whose
 * momskod is a reverse-charge purchase) takes its share out of the pair, which
 * goes when nothing is left, and is self-assessed at that account's momssats,
 * where the declaration buckets its basis. Every pair balances on its own, so
 * the verifikat still does.
 *
 * Each door settles once, after its account_override and before it previews,
 * learns or books the result; evaluateMappingRules returns its result settled.
 * A settled set no longer has the builders' shape (rcSetOf), so settling it a
 * second time changes nothing.
 */

/** The offset leg: 4598, or a company's own 4599 that a learned pattern replays. */
const RC_BASIS_OFFSET = /^4[45]9\d$/

interface RcSet {
  /** The fiktiv pair and the basis pair, as the result carries them. */
  lines: VatJournalLine[]
  /** The purchase the builder booked them for: the pair's amount, at the basis account's rate and kind. */
  purchase: { base: number; rate: number; kind: ReverseChargeKind }
  /** Where the basis leg sits: debit for a purchase, credit for a mirrored refund. */
  side: 'debit' | 'credit'
  offsetAccount: string
}

function legAmount(line: VatJournalLine): number {
  return line.debit_amount > 0 ? line.debit_amount : line.credit_amount
}

function sideOf(line: VatJournalLine): 'debit' | 'credit' {
  return line.debit_amount > 0 ? 'debit' : 'credit'
}

/**
 * The reverse-charge set of a result as a builder books it
 * (generateReverseChargePurchaseLines): a basis leg on a static basis account
 * and an offset leg of the same amount on the other side, and one fiktiv pair,
 * the input leg (2645, 2647 for domestic) beside the basis leg and the output
 * leg at the basis account's rate opposite it, charged on the pair's amount
 * (to within the öre the builder's rounding of an unrounded base allows).
 * Business lines (a learned pattern's cost lines) are never a leg. Null for
 * anything else: no set, several, or one already settled (a shrunk pair or a
 * re-rated fiktiv pair no longer fits), which is left as it is.
 */
function rcSetOf(mappingResult: MappingResult): RcSet | null {
  const generated = mappingResult.vat_lines.filter((line) => !line.business_line)
  const legs = generated.filter((line) =>
    isReverseChargeBasisAccount(line.account_number) || RC_BASIS_OFFSET.test(line.account_number),
  )
  if (legs.length !== 2) return null
  const basis = legs.find((line) => isReverseChargeBasisAccount(line.account_number))
  const offset = legs.find((line) => line !== basis)
  if (!basis || !offset || !RC_BASIS_OFFSET.test(offset.account_number)) return null
  const kindAndRate = reverseChargeKindForBasisAccount(basis.account_number)
  if (!kindAndRate) return null
  const side = sideOf(basis)
  const base = legAmount(basis)
  if (sideOf(offset) === side || Math.abs(base - legAmount(offset)) > 0.005) return null

  const [input, output] = generateReverseChargePurchaseLines({ ...kindAndRate, base, basisBase: 0 })
  const fiktiv = generated.filter((line) => isReverseChargeVatAccount(line.account_number))
  if (fiktiv.length !== 2 || !input || !output) return null
  const inputLeg = fiktiv.find((line) => line.account_number === input.account_number)
  const outputLeg = fiktiv.find((line) => line.account_number === output.account_number)
  if (!inputLeg || !outputLeg || sideOf(inputLeg) !== side || sideOf(outputLeg) === side) return null
  const vat = base * kindAndRate.rate
  if (Math.abs(legAmount(inputLeg) - vat) >= 0.01 || Math.abs(legAmount(outputLeg) - vat) >= 0.01) return null

  return {
    lines: [inputLeg, outputLeg, basis, offset],
    purchase: { base, rate: kindAndRate.rate, kind: kindAndRate.kind },
    side,
    offsetAccount: offset.account_number,
  }
}

/**
 * The cost lines the set stands beside, on the basis leg's side (a purchase
 * debits both, a mirrored refund credits both). A single-pair result books one
 * business line, on its debit account for a purchase and its credit account for
 * a refund, carrying the whole purchase. A learned line pattern marks its cost
 * lines business_line.
 */
function costLinesOf(mappingResult: MappingResult, set: RcSet): Array<{ account: string; amount: number }> {
  if (!mappingResult.all_lines_complete) {
    const account = set.side === 'debit' ? mappingResult.debit_account : mappingResult.credit_account
    return [{ account, amount: set.purchase.base }]
  }
  return mappingResult.vat_lines
    .filter((line) => line.business_line && sideOf(line) === set.side && legAmount(line) > 0)
    .map((line) => ({ account: line.account_number, amount: legAmount(line) }))
}

/**
 * The accounts of the cost lines a builder's reverse-charge set stands beside
 * (costLinesOf), or null when the result carries no such set. Read before
 * the set is settled: a door refuses an account that cannot take the purchase
 * (reverseChargeAccountConflict) instead of settling it.
 */
export function reverseChargeCostAccounts(mappingResult: MappingResult): string[] | null {
  const set = rcSetOf(mappingResult)
  return set ? costLinesOf(mappingResult, set).map((line) => line.account) : null
}

/** See the module comment. Returns `mappingResult` itself when the set stays as it is. */
export function reconcileRcBasisWithCostLines(
  mappingResult: MappingResult,
  chart: ChartVatTreatments,
): MappingResult {
  const set = rcSetOf(mappingResult)
  if (!set) return mappingResult
  const purchases = reverseChargePurchasesOn(set.purchase, costLinesOf(mappingResult, set), chart)
  const [only] = purchases
  if (
    purchases.length === 1 &&
    only.rate === set.purchase.rate &&
    only.base === set.purchase.base &&
    only.basisBase === set.purchase.base
  ) {
    return mappingResult
  }
  const settled: VatJournalLine[] = purchases.flatMap(generateReverseChargePurchaseLines).map((line) => ({
    account_number: line.account_number === RC_BASIS_OFFSET_ACCOUNT ? set.offsetAccount : line.account_number,
    debit_amount: set.side === 'debit' ? line.debit_amount : line.credit_amount,
    credit_amount: set.side === 'debit' ? line.credit_amount : line.debit_amount,
    description: line.line_description || '',
  }))
  // In place of the set, where its first line stood.
  const at = mappingResult.vat_lines.findIndex((line) => set.lines.includes(line))
  const rest = mappingResult.vat_lines.filter((line) => !set.lines.includes(line))
  return { ...mappingResult, vat_lines: [...rest.slice(0, at), ...settled, ...rest.slice(at)] }
}

/**
 * reconcileRcBasisWithCostLines with the company's chart, read only when the
 * result carries a set to settle: a booking without reverse charge costs no
 * query.
 */
export async function reconcileRcBasisWithChart(
  mappingResult: MappingResult,
  loadChart: ChartVatTreatmentsLoader,
): Promise<MappingResult> {
  if (!rcSetOf(mappingResult)) return mappingResult
  return reconcileRcBasisWithCostLines(mappingResult, await loadChart())
}
