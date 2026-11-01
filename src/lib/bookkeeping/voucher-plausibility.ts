/**
 * Booking-time plausibility checks for a verifikat whose lines a person or an
 * agent typed: the manual voucher, inbox "Bokför direkt", a bank row booked on
 * edited lines, and the MCP and v1 vouchers.
 *
 * Structured flows compute VAT from a rate and a base and stay inside the
 * legal rates. Typed lines do not: a forensic sweep of production on
 * 2026-10-26 found 16-22 % of the typed doors' VAT vouchers off every legal
 * ratio, against under 1 % for invoices, and hand checks against the underlag
 * confirmed the shapes below as real errors: a receipt's discount total typed
 * as VAT, VAT kept on items left out of the cost, a reverse-charge purchase
 * booked as a lone 2614 debit, input VAT on 2631, stock purchases debited to a
 * revenue account.
 *
 * Every finding is a warning the person confirms, never a refusal, because
 * each shape has a lawful exception: an insurer-paid repair invoice carries
 * more VAT than the cost the policyholder pays, a business without deduction
 * right books reverse-charge output with no input, a bad-debt write-off
 * reduces output VAT next to a cost. Low ratios are never flagged: the
 * representation cap, partial deduction and VAT-free fee lines all lower the
 * VAT share lawfully.
 *
 * The VAT accounts are classified by the momsdeklaration's own account table
 * (VAT_ACCOUNT_TABLE), so a check and the declaration read an account the same
 * way. Pure: lines in, warnings out.
 */
import { netVat } from '@/lib/bookkeeping/gross-split'
import { roundOre } from '@/lib/money'
import { formatAmount } from '@/lib/utils'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'

export interface PlausibilityLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

/** Every warning a typed verifikat can get, plausibility and duplicate checks alike. */
export const VOUCHER_WARNING_CODES = [
  'INPUT_VAT_ABOVE_RATE',
  'OUTPUT_VAT_ABOVE_RATE',
  'INPUT_VAT_ON_OUTPUT_ACCOUNT',
  'REVERSE_CHARGE_ONE_SIDED',
  'REVENUE_DEBITED_IN_PURCHASE',
  'POSSIBLE_DUPLICATE_VOUCHER',
  'BANK_MOVEMENT_ALREADY_BOOKED',
] as const

export type VoucherWarningCode = (typeof VOUCHER_WARNING_CODES)[number]

export interface VoucherWarning {
  code: VoucherWarningCode
  message_sv: string
  message_en: string
  details: Record<string, unknown>
}

/** The highest Swedish VAT rate: no VAT line can exceed this share of what it applies to. */
const MAX_VAT_RATE = 0.25
/** Room for per-line öre rounding and öresutjämning before a ratio counts as too high. */
const RATIO_TOLERANCE_KR = 1

function boxOf(account: string): string | undefined {
  return VAT_ACCOUNT_TABLE[account]?.box
}

function inRange(account: string, low: string, high: string): boolean {
  return isAccountNumber(account) && account >= low && account <= high
}

const isDomesticOutputVat = (a: string) => a.startsWith('26') && ['10', '11', '12'].includes(boxOf(a) ?? '')
const isReverseChargeOutputVat = (a: string) => ['30', '31', '32'].includes(boxOf(a) ?? '')
const isImportOutputVat = (a: string) => ['60', '61', '62'].includes(boxOf(a) ?? '')
const isReverseChargeInputVat = (a: string) => a === '2645' || a === '2647'
const isInputVat = (a: string) => boxOf(a) === '48'
const isRevenue = (a: string) => inRange(a, '3000', '3999')
/** 37xx are revenue corrections (lämnade rabatter, öresutjämning): debited in the normal course. */
const isRevenueProper = (a: string) => isRevenue(a) && !inRange(a, '3700', '3799')
/** What a purchase's VAT applies to: costs, fixed assets and inventory, prepaid costs. */
const isCostBase = (a: string) => inRange(a, '4000', '8999') || inRange(a, '1000', '1499') || inRange(a, '1700', '1799')
const isReceivable = (a: string) => inRange(a, '1500', '1599')
const isSupplierLiability = (a: string) => inRange(a, '2440', '2449')

function sum(lines: readonly PlausibilityLine[], match: (account: string) => boolean, side: 'debit' | 'credit' | 'net_debit' | 'net_credit'): number {
  let total = 0
  for (const line of lines) {
    if (!match(line.account_number)) continue
    const debit = Number(line.debit_amount) || 0
    const credit = Number(line.credit_amount) || 0
    total += side === 'debit' ? debit : side === 'credit' ? credit : side === 'net_debit' ? debit - credit : credit - debit
  }
  return roundOre(total)
}

function accountsWhere(lines: readonly PlausibilityLine[], match: (line: PlausibilityLine) => boolean): string[] {
  return [...new Set(lines.filter(match).map((l) => l.account_number))].sort()
}

function kr(amount: number): string {
  return `${formatAmount(amount)} kr`
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 1000) / 10
}

/**
 * Whether a verifikat booked a purchase at all: a cost, an asset or a prepaid
 * cost (what a purchase's VAT applies to), a supplier invoice, or input VAT on
 * the debit side, where only a purchase puts it. A verifikat with none of them
 * moved money without buying anything (a sale, a share issue, a transfer
 * between the company's own accounts, a tax, loan or dividend settlement), so
 * no receipt exists for it. Kvittojakten reads it (lib/receipt-hunt).
 */
export function booksPurchase(lines: readonly Pick<PlausibilityLine, 'account_number' | 'debit_amount'>[]): boolean {
  return lines.some(
    (l) =>
      isCostBase(l.account_number) ||
      isSupplierLiability(l.account_number) ||
      (isInputVat(l.account_number) && Number(l.debit_amount) > 0),
  )
}

/** Kundfordringar: what a customer invoice is booked on, and paid off. */
const isCustomerReceivable = (a: string) => inRange(a, '1510', '1519')

/** Whose invoice a verifikat settles or registers. */
export type InvoiceSide = 'supplier' | 'customer'

/**
 * Which invoice a verifikat pays off, from what it books: a payment of a
 * supplier invoice debits leverantörsskulder, a payment of a customer invoice
 * credits kundfordringar. Null for anything else. Kvittojakten reads it
 * (lib/receipt-hunt/underlag-elsewhere).
 */
export function invoiceSettled(lines: readonly PlausibilityLine[]): InvoiceSide | null {
  if (sum(lines, isSupplierLiability, 'debit') > 0) return 'supplier'
  if (sum(lines, isCustomerReceivable, 'credit') > 0) return 'customer'
  return null
}

/**
 * Whether a verifikat registers an invoice of that side: it credits
 * leverantörsskulder, or debits kundfordringar.
 */
export function registersInvoice(lines: readonly PlausibilityLine[], side: InvoiceSide): boolean {
  return side === 'supplier'
    ? sum(lines, isSupplierLiability, 'credit') > 0
    : sum(lines, isCustomerReceivable, 'debit') > 0
}

export function checkVoucherPlausibility(lines: readonly PlausibilityLine[]): VoucherWarning[] {
  const warnings: VoucherWarning[] = []

  const domesticInputVat = sum(lines, (a) => isInputVat(a) && !isReverseChargeInputVat(a), 'net_debit')
  const reverseChargeInputVat = sum(lines, isReverseChargeInputVat, 'net_debit')
  const domesticOutputVat = sum(lines, isDomesticOutputVat, 'net_credit')
  const domesticOutputVatDebit = sum(lines, isDomesticOutputVat, 'debit')
  const reverseChargeOutputCredit = sum(lines, isReverseChargeOutputVat, 'credit')
  const reverseChargeOutputDebit = sum(lines, isReverseChargeOutputVat, 'debit')
  const importOutputVat = sum(lines, isImportOutputVat, 'net_credit')
  const costBase = sum(lines, isCostBase, 'net_debit')
  const revenueBase = sum(lines, isRevenue, 'net_credit')
  const revenueProperCredit = sum(lines, isRevenueProper, 'credit')
  const revenueProperDebit = sum(lines, isRevenueProper, 'debit')
  // Öresutjämning (3740) rides on purchases too, so a sale is a 30-36xx or 38-39xx line.
  const hasRevenueLine = lines.some((l) => isRevenueProper(l.account_number))
  const receivableCredit = sum(lines, isReceivable, 'credit')
  const supplierLiabilityCredit = sum(lines, isSupplierLiability, 'credit')
  const hasReverseChargeOrImport = lines.some(
    (l) => isReverseChargeOutputVat(l.account_number) || isImportOutputVat(l.account_number) || isReverseChargeInputVat(l.account_number),
  )

  if (!hasReverseChargeOrImport && domesticInputVat > 0 && costBase > 0 && domesticInputVat > netVat(costBase, MAX_VAT_RATE) + RATIO_TOLERANCE_KR) {
    const share = percent(domesticInputVat, costBase)
    warnings.push({
      code: 'INPUT_VAT_ABOVE_RATE',
      message_sv: `Ingående moms ${kr(domesticInputVat)} är ${share} % av kostnaden ${kr(costBase)}. Moms är högst 25 % av det den gäller: stäm av beloppet mot underlaget.`,
      message_en: `Input VAT ${kr(domesticInputVat)} is ${share} % of the cost ${kr(costBase)}. VAT is at most 25 % of what it applies to: check the amount against the underlag.`,
      details: { input_vat: domesticInputVat, cost_base: costBase, share_percent: share },
    })
  }

  if (domesticOutputVat > 0 && revenueBase > 0 && domesticOutputVat > netVat(revenueBase, MAX_VAT_RATE) + RATIO_TOLERANCE_KR) {
    const share = percent(domesticOutputVat, revenueBase)
    warnings.push({
      code: 'OUTPUT_VAT_ABOVE_RATE',
      message_sv: `Utgående moms ${kr(domesticOutputVat)} är ${share} % av försäljningen ${kr(revenueBase)}. Moms är högst 25 % av beskattningsunderlaget: är momsen räknad på beloppet inklusive moms?`,
      message_en: `Output VAT ${kr(domesticOutputVat)} is ${share} % of the sales ${kr(revenueBase)}. VAT is at most 25 % of the taxable amount: was it computed on the amount including VAT?`,
      details: { output_vat: domesticOutputVat, revenue_base: revenueBase, share_percent: share },
    })
  }

  // A purchase (a cost, no sale) whose VAT sits in debet on an utgående-moms
  // account. A bad-debt write-off has the same lines but credits the
  // receivable, so it stays out.
  if (domesticOutputVatDebit > 0 && costBase > 0 && !hasRevenueLine && receivableCredit === 0) {
    const accounts = accountsWhere(lines, (l) => isDomesticOutputVat(l.account_number) && Number(l.debit_amount) > 0)
    warnings.push({
      code: 'INPUT_VAT_ON_OUTPUT_ACCOUNT',
      message_sv: `Momsen på ett inköp är bokförd i debet på ${accounts.join(', ')} (utgående moms). Ingående moms på ett inköp bokförs på 2641 och redovisas i ruta 48.`,
      message_en: `The VAT on a purchase is debited to ${accounts.join(', ')} (output VAT). Input VAT on a purchase goes on 2641 and is reported in box 48.`,
      details: { accounts, amount: domesticOutputVatDebit },
    })
  }

  const reverseChargeOutputAccounts = accountsWhere(lines, (l) => isReverseChargeOutputVat(l.account_number))
  if (reverseChargeOutputDebit > 0 && costBase > 0 && reverseChargeInputVat <= 0) {
    warnings.push({
      code: 'REVERSE_CHARGE_ONE_SIDED',
      message_sv: `Omvänd moms är bokförd i debet på ${reverseChargeOutputAccounts.join(', ')} utan ingående moms. Vid ett inköp med omvänd betalningsskyldighet krediteras ${reverseChargeOutputAccounts.join(', ')} och 2645 (eller 2647) debiteras med samma belopp.`,
      message_en: `Reverse-charge VAT is debited to ${reverseChargeOutputAccounts.join(', ')} with no input VAT. A reverse-charge purchase credits ${reverseChargeOutputAccounts.join(', ')} and debits 2645 (or 2647) with the same amount.`,
      details: { variant: 'output_debited', accounts: reverseChargeOutputAccounts, amount: reverseChargeOutputDebit },
    })
  } else if (reverseChargeOutputCredit > 0 && reverseChargeInputVat + domesticInputVat <= 0) {
    warnings.push({
      code: 'REVERSE_CHARGE_ONE_SIDED',
      message_sv: `Utgående moms med omvänd betalningsskyldighet (${reverseChargeOutputAccounts.join(', ')}) har ingen ingående moms i samma verifikation. Har företaget avdragsrätt ska 2645 (eller 2647) debiteras med samma belopp.`,
      message_en: `Reverse-charge output VAT (${reverseChargeOutputAccounts.join(', ')}) has no input VAT in the same voucher. A company with deduction right debits 2645 (or 2647) with the same amount.`,
      details: { variant: 'output_without_input', accounts: reverseChargeOutputAccounts, amount: reverseChargeOutputCredit },
    })
  } else if (reverseChargeInputVat > 0 && reverseChargeOutputCredit <= 0 && importOutputVat <= 0) {
    warnings.push({
      code: 'REVERSE_CHARGE_ONE_SIDED',
      message_sv: 'Beräknad ingående moms (2645/2647) är bokförd utan utgående moms med omvänd betalningsskyldighet. Avdraget förutsätter att samma belopp redovisas som utgående moms på 2614, 2624 eller 2634.',
      message_en: 'Calculated input VAT (2645/2647) is booked with no reverse-charge output VAT. The deduction requires the same amount as output VAT on 2614, 2624 or 2634.',
      details: { variant: 'input_without_output', amount: reverseChargeInputVat },
    })
  }

  // A revenue account debited where nothing is sold and the voucher claims
  // input VAT or owes a supplier: a purchase booked as negative revenue.
  // Refunds and credit notes reverse output VAT or credit 1510 instead, and
  // a reclass between revenue accounts credits revenue, so all three stay out.
  if (revenueProperDebit > 0 && revenueProperCredit === 0 && (domesticInputVat + reverseChargeInputVat > 0 || supplierLiabilityCredit > 0)) {
    const accounts = accountsWhere(lines, (l) => isRevenueProper(l.account_number) && Number(l.debit_amount) > 0)
    warnings.push({
      code: 'REVENUE_DEBITED_IN_PURCHASE',
      message_sv: `Intäktskontot ${accounts.join(', ')} debiteras i en verifikation med ingående moms eller leverantörsskuld, alltså ett inköp. Ett inköp bokförs på ett kostnadskonto (klass 4-7), inte som minskad intäkt.`,
      message_en: `Revenue account ${accounts.join(', ')} is debited in a voucher with input VAT or a supplier liability, which is a purchase. A purchase goes on a cost account (classes 4-7), not as reduced revenue.`,
      details: { accounts, amount: revenueProperDebit },
    })
  }

  return warnings
}
