import type { SpendExpenseKind, SpendRejectionCode } from '@accounted/connect-contract'
import { roundOre, sumOre } from '@/lib/money'
import {
  generateReverseChargePurchaseLines,
  reverseChargePurchasesOn,
  type ChartVatTreatments,
  type ReverseChargeKind,
} from '@/lib/bookkeeping/vat-entries'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { grossVat } from '@/lib/bookkeeping/gross-split'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { sellerVatIsCost, type VatRegistration } from '@/lib/bookkeeping/vat-registration'
import type { CreateJournalEntryLineInput } from '@/types'
import type { SpendSettings } from './settings'
import type { SpendExpenseModel } from './types'
import { findSpendVatCode, REPRESENTATION_ACCOUNTS, SIMPLIFIED_RECEIPT_VAT_LIMIT } from './vat-codes'

/**
 * Provider-neutral: from a spend expense (the contract's model) and the
 * company's context to where the expense stands and the verifikat it books
 * as. Pure, so the intake, the list, the preview, the booking and the tests
 * all agree.
 *
 * Three outcomes at intake:
 *
 *   rejected  sent back to the provider with a reason in Swedish: the coding
 *             cannot be booked here (an unknown account or VAT code, a locked
 *             period). The person fixes it at the provider and exports again.
 *   review    received, but a person looks before it is booked: something
 *             Swedish law or the company decides that the coding alone does
 *             not (a receipt missing for the VAT, representation, payroll).
 *   ready     received and bookable as it is, alone or in a batch.
 *
 * Kinds that move money between the company's own accounts (a wallet top-up
 * or unload, a reimbursement paid outside the provider) are no_entry: the
 * bank row is where that money moved and where it is booked, once.
 *
 * The verifikat, one per expense (BFL 5 kap 6 §):
 *
 *   debit   each line's account, the net (VAT excluded)
 *   debit   input VAT on 2641, from the receipt, for Swedish VAT codes
 *   either  the reverse-charge set for reverse codes (2645 / 2614 and the
 *           basis pair), from generateReverseChargePurchaseLines
 *   credit  the counter side the kind names: the wallet for card spend, the
 *           utlägg account for what is owed to a person
 *
 * Amounts are signed (positive is money out); a refund swaps every side.
 */

export type SpendReviewCode =
  | 'vat_without_receipt'
  | 'vat_over_simplified_limit'
  | 'representation'
  | 'foreign_merchant_domestic_vat'
  | 'vat_amount_mismatch'
  | 'payroll_related'
  | 'counter_account_needed'
  | 'wallet_account_differs'
  | 'no_fiscal_period'
  | 'provider_issue'

export type SpendReasonCode = SpendRejectionCode | SpendReviewCode

export interface SpendReason {
  code: SpendReasonCode
  /** Values the UI interpolates; never prose. */
  params: Record<string, string | number>
  /** For provider_issue: the service's own wording, shown as is. */
  message?: string
}

export type SpendEvaluationStatus = 'ready' | 'review' | 'rejected' | 'no_entry'

export interface SpendEvaluation {
  status: SpendEvaluationStatus
  reasons: SpendReason[]
  /** Set when status is rejected: what the provider is told. */
  rejection: { code: SpendRejectionCode; reasonSv: string } | null
}

export interface SpendEvaluationContext {
  /** True when the engine can book on the account: active in the chart, or a standard BAS account not deactivated. */
  isBookableAccount: (account: string) => boolean
  vatRegistered: VatRegistration
  settings: SpendSettings
  providerName: string
  /** The expense date's lock verdict (checkPeriodLock). */
  period: { locked: boolean; hasFiscalPeriod: boolean }
  /** The first dimension pair the registry refuses, when dimensions are switched on; null when every pair is known. */
  dimensionProblem: { dimension: string; value: string } | null
}

/** Card spend and its reversals: the counter side is the wallet. */
const WALLET_KINDS: ReadonlySet<SpendExpenseKind> = new Set(['card_purchase', 'card_invoice', 'fee', 'refund', 'chargeback', 'cashback'])
/** Owed to the person until paid back: the counter side is the utlägg account. */
const PAYABLE_KINDS: ReadonlySet<SpendExpenseKind> = new Set(['out_of_pocket', 'mileage', 'per_diem'])
/** The person picks the debit side: a receivable, an eget uttag, cash held. */
const PERSON_DECIDES_KINDS: ReadonlySet<SpendExpenseKind> = new Set(['personal_spend', 'atm_withdrawal'])
/** Money between the company's own accounts: booked from the bank row. */
export const NO_ENTRY_KINDS: ReadonlySet<SpendExpenseKind> = new Set(['wallet_topup', 'wallet_unload', 'external_reimbursement'])
/** Not booked from this feed yet. */
const UNSUPPORTED_KINDS: ReadonlySet<SpendExpenseKind> = new Set(['invoice', 'invoice_payment', 'balance_adjustment', 'other'])

/** VAT the provider states may differ this much from the rate's VAT before a person looks. */
const VAT_TOLERANCE = 1

const KIND_LABELS_SV: Record<SpendExpenseKind, string> = {
  card_purchase: 'Kortköp',
  card_invoice: 'Kortbetald faktura',
  fee: 'Avgift',
  refund: 'Återbetalning',
  chargeback: 'Återkrav',
  cashback: 'Cashback',
  out_of_pocket: 'Utlägg',
  mileage: 'Milersättning',
  per_diem: 'Traktamente',
  reimbursement: 'Återbetalt utlägg',
  external_reimbursement: 'Utlägg återbetalt utanför plattformen',
  wallet_topup: 'Insättning på kortkontot',
  wallet_unload: 'Uttag från kortkontot',
  atm_withdrawal: 'Kontantuttag',
  personal_spend: 'Privat köp',
  invoice: 'Leverantörsfaktura',
  invoice_payment: 'Fakturabetalning',
  balance_adjustment: 'Saldojustering',
  other: 'Utgift',
}

export function spendKindLabel(kind: SpendExpenseKind): string {
  return KIND_LABELS_SV[kind]
}

/** The wallet account a wallet-side booking uses: the company's choice first, the provider's mapping second. */
export function resolveWalletAccount(expense: Pick<SpendExpenseModel, 'walletAccount'>, settings: SpendSettings): string | null {
  return settings.wallet_account ?? expense.walletAccount ?? null
}

function touchesWallet(kind: SpendExpenseKind): boolean {
  return WALLET_KINDS.has(kind) || PERSON_DECIDES_KINDS.has(kind) || kind === 'reimbursement'
}

function needsCodedLines(kind: SpendExpenseKind): boolean {
  return WALLET_KINDS.has(kind) || PAYABLE_KINDS.has(kind)
}

function reject(code: SpendRejectionCode, reasonSv: string, params: Record<string, string | number> = {}): SpendEvaluation {
  return { status: 'rejected', reasons: [{ code, params }], rejection: { code, reasonSv } }
}

export function evaluateSpendExpense(expense: SpendExpenseModel, ctx: SpendEvaluationContext): SpendEvaluation {
  const kind = expense.kind
  if (UNSUPPORTED_KINDS.has(kind)) {
    return reject(
      'kind_unsupported',
      `Accounted tar ännu inte emot ${spendKindLabel(kind).toLowerCase()} härifrån. Bokför den direkt i Accounted.`,
      { kind },
    )
  }
  if (NO_ENTRY_KINDS.has(kind)) return { status: 'no_entry', reasons: [], rejection: null }

  if (!isLedgerCurrency(expense.currency)) {
    return reject(
      'currency_unsupported',
      `Accounted tar ännu bara emot utgifter från ett kortkonto i svenska kronor (det här är ${expense.currency}).`,
      { currency: expense.currency },
    )
  }

  if (needsCodedLines(kind)) {
    if (expense.lines.length === 0) {
      return reject('account_missing', 'Utgiften saknar konto. Välj en kategori som har ett konto och exportera igen.')
    }
    for (const line of expense.lines) {
      if (!line.account) {
        return reject('account_missing', 'En rad saknar konto. Välj en kategori som har ett konto och exportera igen.')
      }
      if (!ctx.isBookableAccount(line.account)) {
        return reject(
          'account_unknown',
          `Konto ${line.account} finns inte i Accounted eller är avstängt. Välj ett annat konto, eller aktivera kontot i Accounted, och exportera igen.`,
          { account: line.account },
        )
      }
      if (!line.vat || !line.vat.code) {
        return reject('vat_code_missing', 'En rad saknar momskod. Välj en av momskoderna från Accounted och exportera igen.')
      }
      if (!findSpendVatCode(line.vat.code, ctx.vatRegistered)) {
        return reject(
          'vat_code_unknown',
          `Momskoden ${line.vat.code} finns inte i Accounted. Välj en av momskoderna från Accounted och exportera igen.`,
          { vat_code: line.vat.code },
        )
      }
    }
    const linesTotal = sumOre(expense.lines.map((line) => line.amount))
    if (roundOre(linesTotal - expense.amount) !== 0) {
      return reject(
        'amounts_mismatch',
        'Raderna summerar inte till utgiftens belopp. Kontrollera uppdelningen och exportera igen.',
        { lines_total: linesTotal, amount: expense.amount },
      )
    }
  }

  const reasons: SpendReason[] = []
  if (touchesWallet(kind)) {
    const wallet = resolveWalletAccount(expense, ctx.settings)
    if (!wallet) {
      return reject(
        'wallet_account_unknown',
        `Inget konto för kortkontot är valt. Välj det i Accounted under Inställningar, Kopplingar, ${ctx.providerName}, eller ange ett motkonto här.`,
      )
    }
    if (!ctx.isBookableAccount(wallet)) {
      return reject(
        'account_unknown',
        `Konto ${wallet} för kortkontot finns inte i Accounted eller är avstängt. Lägg upp det i Accounted och exportera igen.`,
        { account: wallet },
      )
    }
    if (ctx.settings.wallet_account && expense.walletAccount && expense.walletAccount !== ctx.settings.wallet_account) {
      reasons.push({ code: 'wallet_account_differs', params: { settings: ctx.settings.wallet_account, provider: expense.walletAccount } })
    }
  }
  if (PAYABLE_KINDS.has(kind) || kind === 'reimbursement') {
    if (!ctx.isBookableAccount(ctx.settings.out_of_pocket_account)) {
      return reject(
        'account_unknown',
        `Utläggskontot ${ctx.settings.out_of_pocket_account} finns inte i Accounted eller är avstängt. Välj ett annat i Accounted och exportera igen.`,
        { account: ctx.settings.out_of_pocket_account },
      )
    }
  }

  if (ctx.period.locked) {
    return reject('period_locked', `Perioden för ${expense.date} är låst i Accounted, så utgiften kan inte bokföras där.`, { date: expense.date })
  }
  if (ctx.dimensionProblem) {
    return reject(
      'dimension_unknown',
      `${ctx.dimensionProblem.dimension} ${ctx.dimensionProblem.value} finns inte i Accounted. Välj en annan tagg, eller lägg upp den i Accounted, och exportera igen.`,
      { dimension: ctx.dimensionProblem.dimension, value: ctx.dimensionProblem.value },
    )
  }
  if (!ctx.period.hasFiscalPeriod) reasons.push({ code: 'no_fiscal_period', params: { date: expense.date } })

  const hasReceipt = expense.files.length > 0
  let domesticVat = false
  let reverseVat = false
  for (const line of expense.lines) {
    const definition = line.vat?.code ? findSpendVatCode(line.vat.code, ctx.vatRegistered) : null
    if (!definition) continue
    if (definition.handling.kind === 'domestic') {
      domesticVat = true
      if (line.vat?.amount != null) {
        const expected = grossVat(line.amount, definition.handling.rate)
        if (Math.abs(line.vat.amount - expected) > VAT_TOLERANCE) {
          // Kronor: an expense in any other currency was rejected above.
          reasons.push({ code: 'vat_amount_mismatch', params: { stated_sek: line.vat.amount, expected_sek: expected } })
        }
      }
    }
    if (definition.handling.kind === 'reverse') reverseVat = true
  }
  if ((domesticVat || reverseVat) && !hasReceipt && needsCodedLines(kind)) {
    reasons.push({ code: 'vat_without_receipt', params: {} })
  }
  if (domesticVat && Math.abs(expense.amount) > SIMPLIFIED_RECEIPT_VAT_LIMIT) {
    reasons.push({ code: 'vat_over_simplified_limit', params: { amount_sek: expense.amount, limit_sek: SIMPLIFIED_RECEIPT_VAT_LIMIT } })
  }
  if (expense.lines.some((line) => line.account && REPRESENTATION_ACCOUNTS.has(line.account))) {
    reasons.push({ code: 'representation', params: { attendees: expense.attendees.length } })
  }
  if (domesticVat && expense.merchant?.country && expense.merchant.country !== 'SE') {
    reasons.push({ code: 'foreign_merchant_domestic_vat', params: { country: expense.merchant.country } })
  }
  if (kind === 'mileage' || kind === 'per_diem') reasons.push({ code: 'payroll_related', params: { kind } })
  if (PERSON_DECIDES_KINDS.has(kind)) reasons.push({ code: 'counter_account_needed', params: { kind } })
  for (const issue of expense.issues) {
    reasons.push({ code: 'provider_issue', params: { code: issue.code }, message: issue.message })
  }

  return reasons.length > 0 ? { status: 'review', reasons, rejection: null } : { status: 'ready', reasons: [], rejection: null }
}

// ---------------------------------------------------------------------------
// The verifikat
// ---------------------------------------------------------------------------

export interface SpendEntryContext {
  settings: SpendSettings
  vatRegistered: VatRegistration
  chart: ChartVatTreatments
  /** For personal_spend and atm_withdrawal: the account the person chose for the debit side. */
  debitAccount?: string
}

export interface SpendEntryPlan {
  lines: CreateJournalEntryLineInput[]
  /** Reasons the verifikat cannot be built; empty when `lines` balance. */
  problems: SpendReason[]
  /** The Swedish input VAT the lines deduct, in kronor (0 when none or not built). */
  deductibleVat: number
}

/** A signed amount as one journal line on the side its sign says; null for zero. */
function signedLine(
  accountNumber: string,
  side: 'debit' | 'credit',
  amount: number,
  description: string,
  dimensions?: Record<string, string>,
): CreateJournalEntryLineInput | null {
  const rounded = roundOre(amount)
  if (rounded === 0) return null
  const effective = rounded > 0 ? side : side === 'debit' ? 'credit' : 'debit'
  const value = Math.abs(rounded)
  return {
    account_number: accountNumber,
    debit_amount: effective === 'debit' ? value : 0,
    credit_amount: effective === 'credit' ? value : 0,
    line_description: description,
    ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
  }
}

/** The reverse-charge set mirrored for a refund: every debit becomes a credit and back. */
function mirror(lines: CreateJournalEntryLineInput[]): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({ ...line, debit_amount: line.credit_amount, credit_amount: line.debit_amount }))
}

function lineText(expense: SpendExpenseModel, description: string | null): string {
  return (description ?? expense.merchant?.name ?? spendKindLabel(expense.kind)).slice(0, 200)
}

export function buildSpendItemEntry(expense: SpendExpenseModel, ctx: SpendEntryContext): SpendEntryPlan {
  const kind = expense.kind
  if (UNSUPPORTED_KINDS.has(kind) || NO_ENTRY_KINDS.has(kind)) {
    return { lines: [], problems: [{ code: 'kind_unsupported', params: { kind } }], deductibleVat: 0 }
  }
  const lines: CreateJournalEntryLineInput[] = []
  const push = (line: CreateJournalEntryLineInput | null) => {
    if (line) lines.push(line)
  }
  const wallet = resolveWalletAccount(expense, ctx.settings)

  if (kind === 'reimbursement') {
    if (!wallet) return { lines: [], problems: [{ code: 'wallet_account_unknown', params: {} }], deductibleVat: 0 }
    push(signedLine(ctx.settings.out_of_pocket_account, 'debit', expense.amount, 'Återbetalt utlägg'))
    push(signedLine(wallet, 'credit', expense.amount, 'Utbetalt från kortkontot'))
    return { lines, problems: [], deductibleVat: 0 }
  }

  if (PERSON_DECIDES_KINDS.has(kind)) {
    if (!wallet) return { lines: [], problems: [{ code: 'wallet_account_unknown', params: {} }], deductibleVat: 0 }
    if (!ctx.debitAccount) return { lines: [], problems: [{ code: 'counter_account_needed', params: { kind } }], deductibleVat: 0 }
    push(signedLine(ctx.debitAccount, 'debit', expense.amount, spendKindLabel(kind)))
    push(signedLine(wallet, 'credit', expense.amount, spendKindLabel(kind)))
    return { lines, problems: [], deductibleVat: 0 }
  }

  const counter = PAYABLE_KINDS.has(kind) ? ctx.settings.out_of_pocket_account : wallet
  if (!counter) return { lines: [], problems: [{ code: 'wallet_account_unknown', params: {} }], deductibleVat: 0 }
  if (expense.lines.length === 0) return { lines: [], problems: [{ code: 'account_missing', params: {} }], deductibleVat: 0 }

  const hasReceipt = expense.files.length > 0
  let deductibleVat = 0
  // Reverse-charge purchases are collected per kind and rate and booked once
  // through the sanctioned generator, against the cost lines they sit on.
  const reverse = new Map<string, { kind: ReverseChargeKind; rate: number; base: number; costLines: Array<{ account: string; amount: number }> }>()

  for (const line of expense.lines) {
    if (!line.account) return { lines: [], problems: [{ code: 'account_missing', params: {} }], deductibleVat: 0 }
    const definition = findSpendVatCode(line.vat?.code, ctx.vatRegistered)
    if (!definition) return { lines: [], problems: [{ code: 'vat_code_unknown', params: { vat_code: line.vat?.code ?? '' } }], deductibleVat: 0 }
    const text = lineText(expense, line.description)
    const handling = definition.handling

    if (handling.kind === 'domestic' && hasReceipt && !sellerVatIsCost(ctx.vatRegistered, false)) {
      const stated = line.vat?.amount
      const vat = stated != null && Math.abs(stated) <= Math.abs(line.amount) ? roundOre(stated) : grossVat(line.amount, handling.rate)
      push(signedLine(line.account, 'debit', roundOre(line.amount - vat), text, line.dimensions))
      push(signedLine(handling.account, 'debit', vat, `Ingående moms ${Math.round(handling.rate * 100)} %`))
      deductibleVat = roundOre(deductibleVat + vat)
      continue
    }

    // No deductible VAT: the gross is the cost (no VAT at all, foreign VAT,
    // a company that is not registered, or a receipt still missing).
    push(signedLine(line.account, 'debit', line.amount, text, line.dimensions))
    if (handling.kind === 'reverse') {
      const key = `${handling.reverseKind}:${handling.rate}`
      const group = reverse.get(key) ?? { kind: handling.reverseKind, rate: handling.rate, base: 0, costLines: [] }
      group.base = roundOre(group.base + line.amount)
      group.costLines.push({ account: line.account, amount: Math.abs(line.amount) })
      reverse.set(key, group)
    }
  }

  for (const group of reverse.values()) {
    const base = Math.abs(group.base)
    if (base === 0) continue
    const purchases = reverseChargePurchasesOn({ base, rate: group.rate, kind: group.kind }, group.costLines, ctx.chart)
    const set = purchases.flatMap((purchase) => generateReverseChargePurchaseLines(purchase))
    lines.push(...(group.base < 0 ? mirror(set) : set))
  }

  const debit = sumOre(lines.map((line) => line.debit_amount))
  const credit = sumOre(lines.map((line) => line.credit_amount))
  push(signedLine(counter, 'credit', roundOre(debit - credit), PAYABLE_KINDS.has(kind) ? 'Att betala till den som la ut' : 'Betalt med företagskort'))

  const balance = lineBalance(lines)
  if (!balance.balanced) {
    return { lines: [], problems: [{ code: 'amounts_mismatch', params: { debit: balance.totalDebit, credit: balance.totalCredit } }], deductibleVat: 0 }
  }
  return { lines, problems: [], deductibleVat }
}

/** The verifikat text: what, who, and from which system. At most 200 characters. */
export function spendItemDescription(expense: SpendExpenseModel, providerName: string): string {
  const what = expense.merchant?.name ? `${spendKindLabel(expense.kind)} ${expense.merchant.name}` : spendKindLabel(expense.kind)
  const who = expense.person?.name ? ` (${expense.person.name})` : ''
  const note = expense.note ? `: ${expense.note.replace(/\s+/g, ' ').trim()}` : ''
  return `${what}${who}${note}, ${providerName}`.slice(0, 200)
}

/** The verifikat notes: the provider's reference, the original currency, the attendees. */
export function spendItemNotes(expense: SpendExpenseModel, providerName: string): string {
  const parts: string[] = []
  if (expense.reference) parts.push(`${providerName} ${expense.reference}`)
  if (expense.original) parts.push(`Ursprungligt belopp ${expense.original.amount} ${expense.original.currency}`)
  if (expense.attendees.length > 0) {
    parts.push(`Deltagare: ${expense.attendees.map((a) => (a.company ? `${a.name} (${a.company})` : a.name)).join(', ')}`)
  }
  if (expense.files.length === 0) parts.push('Inget kvitto från utgiftsplattformen.')
  return parts.join('. ').slice(0, 2000)
}
