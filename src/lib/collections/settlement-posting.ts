import type { CollectionsSettlementLine } from '@accounted/connect-contract'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { roundOre, sumOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * The payout voucher of a collections settlement (build spec 4.2 D and 4.3),
 * as a pure plan: which account each line books to, whether the lines add
 * up to what was paid out, and which collected payments (step C) the payout
 * settles. Everything here is a proposal for the accountant's sign-off
 * (build spec 4.5 items 1 and 3 to 8); nothing is booked by this module.
 *
 * Amounts arrive in payout terms (Connect reads the provider's own balanced
 * voucher into them): positive, and the kind gives the direction:
 *
 *   kind                     voucher line            VAT
 *   principal                Cr clearing (1689)      none
 *   interest_to_creditor     Cr 8313                 none
 *   fee_to_creditor          Cr 3990                 none
 *   cost_refund_to_creditor  Cr 6062                 none
 *   agency_commission        Dr 6062 (net)           on the line or a Tax line
 *   agency_fee_vat           Dr VAT account          is the VAT
 *   fee_charged_to_creditor  Dr 6062                 on the line or a Tax line
 *   court_fee                Dr 6062                 none
 *   supplier_invoice_setoff  Dr 2440                 on the supplier invoice
 *   excess_direct_payment    Dr 2890                 none
 *   informational            not booked              n/a
 *   unknown                  a person picks the account; credit when paid to
 *                            the company, debit otherwise
 *
 * Lines the provider keeps out of the payout (`inPayout: false`, such as the
 * payout itself, which the provider's voucher writes as a debit to the bank)
 * are shown, never booked.
 *
 * A deducted kind may arrive negative: the provider credits it back, and it
 * books on the credit side (the provider's test payouts of 2026-10-14 carry
 * a VAT pair, +50 and -40). A negative amount of any other kind, and a
 * negative VAT amount, has no confirmed meaning: a person looks at it.
 *
 * VAT on the provider's fees: the provider may send it as a line of its own
 * (agency_fee_vat), as `taxAmount` on the fee line, or both. When the
 * settlement has a VAT line, the fee lines' `taxAmount` is the same VAT and
 * is not booked again; without one, it is booked as a debit next to the fee.
 * The VAT account is 2641 only for a VAT-registered company whose provider
 * settlement is a valid VAT invoice (the catalogue's settlementIsVatInvoice,
 * and the ledger's own acceptance of it); until then a person chooses 2641
 * or 6062 with the document in view. A company that is not VAT-registered
 * books the VAT as part of the cost, on 6062. A VAT line the payout carries
 * no fee for (no agency_commission or fee_charged_to_creditor beside it)
 * cannot be checked against its base: a person places it, whatever the
 * company's VAT registration and the acceptance of the settlement (the test
 * payouts' VAT pair has no fee line).
 *
 * Balance: the credits minus the debits of the booked lines equal the amount
 * paid out, to the öre; the payout account takes the debit for that amount.
 * Per case: the principal lines of each case (or set of merged cases) equal
 * the capital of its booked, not yet paid out, collected payments, taken in
 * the order they were paid; the clearing account then nets to zero for them.
 */

export type SettlementLineKind = CollectionsSettlementLine['kind']
export type SettlementLineRecipient = CollectionsSettlementLine['recipient']

/** Kinds whose amount is paid to the company (credit). */
const CREDIT_KINDS: ReadonlySet<SettlementLineKind> = new Set([
  'principal',
  'interest_to_creditor',
  'fee_to_creditor',
  'cost_refund_to_creditor',
])

/** Kinds the provider deducts from the payout (debit). */
const DEBIT_KINDS: ReadonlySet<SettlementLineKind> = new Set([
  'agency_commission',
  'agency_fee_vat',
  'fee_charged_to_creditor',
  'court_fee',
  'supplier_invoice_setoff',
  'excess_direct_payment',
])

/** Kinds whose `taxAmount` is VAT on a fee the provider charges the company. */
const VAT_CARRYING_KINDS: ReadonlySet<SettlementLineKind> = new Set(['agency_commission', 'fee_charged_to_creditor'])

/** The fixed account per kind; principal and agency_fee_vat are resolved per company. */
export const SETTLEMENT_KIND_ACCOUNTS: Readonly<Partial<Record<SettlementLineKind, string>>> = {
  interest_to_creditor: '8313',
  fee_to_creditor: '3990',
  cost_refund_to_creditor: '6062',
  agency_commission: '6062',
  fee_charged_to_creditor: '6062',
  court_fee: '6062',
  supplier_invoice_setoff: '2440',
  excess_direct_payment: '2890',
}

/** Debiterad ingående moms (the repo's convention, GENERATED_VAT_ACCOUNTS). */
export const SETTLEMENT_INPUT_VAT_ACCOUNT = '2641'
/** The cost account the provider's fees book to; also VAT that is not deductible. */
export const SETTLEMENT_FEE_ACCOUNT = '6062'

/** Swedish line texts when the provider sends none. */
export const SETTLEMENT_KIND_LABELS_SV: Readonly<Record<SettlementLineKind, string>> = {
  principal: 'Inbetalt kapital',
  interest_to_creditor: 'Ränta till borgenären',
  fee_to_creditor: 'Avgift till borgenären',
  cost_refund_to_creditor: 'Återbetald kostnad',
  agency_commission: 'Provision till inkassobolaget',
  agency_fee_vat: 'Moms på inkassobolagets avgifter',
  fee_charged_to_creditor: 'Avgift från inkassobolaget',
  court_fee: 'Avgift till Kronofogden',
  supplier_invoice_setoff: 'Kvittad faktura från inkassobolaget',
  excess_direct_payment: 'Överskjutande direktbetalning',
  informational: 'Information',
  unknown: 'Okänd rad',
}

export interface SettlementLineInput {
  position: number
  kind: SettlementLineKind
  inPayout: boolean
  recipient: SettlementLineRecipient
  amount: number
  taxAmount: number
  /** The cases the line belongs to: its own case, or the cases of the merged invoices it covers. */
  caseIds: readonly string[]
  /** The accounts a person chose for this line (account_chosen_by set), else null. */
  chosen: { account: string | null; vatAccount: string | null } | null
}

/** A collected payment (step C) of one of the settlement's cases. */
export interface CollectedCapitalInput {
  id: string
  caseId: string
  status: 'pending' | 'booked' | 'needs_review' | 'ignored'
  capitalPaid: number
  paidAt: string
  /** The payout that already settled it; null while not paid out. */
  settlementId: string | null
}

export interface SettlementPlanInput {
  settlementId: string
  amount: number
  currency: string
  paymentDate: string
  providerStatusOk: boolean
  lines: readonly SettlementLineInput[]
  collected: readonly CollectedCapitalInput[]
  clearingAccount: string
  payoutAccount: string
  /** company_settings.vat_registered (a missing value counts as registered). */
  vatRegistered: boolean
  /** The provider settlement is accepted as a valid VAT invoice for the fees it withholds. */
  vatInvoiceAccepted: boolean
}

/** Why a settlement needs a person before it can be booked. */
export type SettlementPlanReason =
  | 'provider_status'
  | 'currency'
  | 'non_positive_payout'
  | 'unknown_line'
  | 'vat_unconfirmed'
  | 'vat_on_line_without_vat'
  | 'unknown_case'
  | 'collected_payment_unbooked'
  | 'case_mismatch'
  | 'unbalanced'

/** Order in which a reason is reported when a settlement has several. */
const REASON_ORDER: readonly SettlementPlanReason[] = [
  'provider_status',
  'currency',
  'non_positive_payout',
  'unknown_case',
  'collected_payment_unbooked',
  'case_mismatch',
  'unknown_line',
  'vat_on_line_without_vat',
  'vat_unconfirmed',
  'unbalanced',
]

export interface SettlementPlanIssue {
  reason: SettlementPlanReason
  /** The line it concerns; null for the settlement as a whole. */
  position: number | null
}

/** The account a line books to; null where a person must choose. */
export interface SettlementLineAccounts {
  position: number
  account: string | null
  vatAccount: string | null
  /** What the view prefills for a person to confirm (never booked without a choice). */
  suggestedAccount: string | null
  /** Whether the line is booked at all (false for lines outside the payout and informational lines). */
  booked: boolean
}

/**
 * A row of the voucher a payout will book, for a payout held only by the
 * accounts a person must choose: the account, or the line and field whose
 * choice fills it. The preview shows it with the choice the person makes,
 * live, and as waiting until then.
 */
export interface SettlementDraftRow {
  account: string | null
  /** The line and the account field a person's choice fills; null when the ledger placed the row. */
  waitsFor: { position: number; field: 'account' | 'vatAccount' } | null
  debit: number
  credit: number
}

export type SettlementPlan =
  | {
      ok: true
      lines: CreateJournalEntryLineInput[]
      lineAccounts: SettlementLineAccounts[]
      /** The collected payments (step C) this payout settles. */
      settles: string[]
      credits: number
      debits: number
    }
  | {
      ok: false
      reason: SettlementPlanReason
      issues: SettlementPlanIssue[]
      lineAccounts: SettlementLineAccounts[]
      details: Record<string, unknown>
      /**
       * The voucher with the rows that wait for a person's account marked,
       * when those choices are all that hold the payout (null when anything
       * else does). With every choice made it is the voucher this planner
       * books: the same rows, amounts and order.
       */
      draft: SettlementDraftRow[] | null
    }

export function lineDirection(line: Pick<SettlementLineInput, 'kind' | 'recipient'>): 'credit' | 'debit' | null {
  if (CREDIT_KINDS.has(line.kind)) return 'credit'
  if (DEBIT_KINDS.has(line.kind)) return 'debit'
  if (line.kind === 'unknown') return line.recipient === 'creditor' ? 'credit' : 'debit'
  return null
}

/** Whether a line enters the voucher (in the payout and not informational). */
export function lineIsBooked(line: Pick<SettlementLineInput, 'kind' | 'inPayout'>): boolean {
  return line.inPayout && line.kind !== 'informational'
}

function validAccount(account: string | null | undefined): string | null {
  return account && isAccountNumber(account) ? account : null
}

/**
 * The VAT account for the provider's fees, or null when a person must
 * choose. `chosen` is the person's choice for this line, if any.
 */
export function resolveVatAccount(
  input: Pick<SettlementPlanInput, 'vatRegistered' | 'vatInvoiceAccepted'>,
  chosen: string | null,
): string | null {
  if (!input.vatRegistered) return SETTLEMENT_FEE_ACCOUNT
  if (input.vatInvoiceAccepted) return SETTLEMENT_INPUT_VAT_ACCOUNT
  return validAccount(chosen)
}

/**
 * The voucher line text: the ledger's own label for the kind, never the
 * provider's free text, which can name the debtor and would then stay in the
 * books for the whole retention period.
 */
function lineText(line: SettlementLineInput): string {
  return SETTLEMENT_KIND_LABELS_SV[line.kind]
}

/** The collected payments a group of principal lines settles: the first ones, in payment order, that sum to the principal. */
function matchCollected(
  principal: number,
  candidates: readonly CollectedCapitalInput[],
): CollectedCapitalInput[] | null {
  const ordered = [...candidates].sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id))
  let sum = 0
  const taken: CollectedCapitalInput[] = []
  for (const payment of ordered) {
    if (roundOre(sum) === principal) break
    sum = roundOre(sum + roundOre(payment.capitalPaid))
    taken.push(payment)
  }
  return roundOre(sum) === principal && taken.length > 0 ? taken : null
}

export function planSettlementVoucher(input: SettlementPlanInput): SettlementPlan {
  const issues: SettlementPlanIssue[] = []
  const amount = roundOre(input.amount)

  if (!input.providerStatusOk) issues.push({ reason: 'provider_status', position: null })
  if (input.currency !== 'SEK') issues.push({ reason: 'currency', position: null })
  if (!(amount > 0)) issues.push({ reason: 'non_positive_payout', position: null })

  const hasVatLine = input.lines.some((line) => line.kind === 'agency_fee_vat' && lineIsBooked(line))
  // A VAT line needs a fee in the same payout to be VAT on; without one only a person places it.
  const hasFeeLine = input.lines.some((line) => VAT_CARRYING_KINDS.has(line.kind) && lineIsBooked(line))
  // The issues a person's account choice settles, and the voucher rows as they stand without those choices.
  const waiting: SettlementPlanIssue[] = []
  const draftRows: SettlementDraftRow[] = []
  const waitFor = (issue: SettlementPlanIssue) => {
    issues.push(issue)
    waiting.push(issue)
  }
  const voucherLines: CreateJournalEntryLineInput[] = []
  const lineAccounts: SettlementLineAccounts[] = []
  const credits: number[] = []
  const debits: number[] = []

  const sorted = [...input.lines].sort((a, b) => a.position - b.position)
  for (const line of sorted) {
    const booked = lineIsBooked(line)
    const lineAmount = roundOre(line.amount)
    const taxAmount = roundOre(line.taxAmount)
    const entry: SettlementLineAccounts = { position: line.position, account: null, vatAccount: null, suggestedAccount: null, booked }
    lineAccounts.push(entry)
    if (!booked) continue

    // A VAT amount on a kind that carries no VAT has no place in the voucher.
    if (taxAmount !== 0 && !VAT_CARRYING_KINDS.has(line.kind)) {
      issues.push({ reason: 'vat_on_line_without_vat', position: line.position })
    }

    // The line's own account.
    if (line.kind === 'principal') {
      entry.account = input.clearingAccount
    } else if (line.kind === 'agency_fee_vat') {
      entry.account = hasFeeLine ? resolveVatAccount(input, line.chosen?.account ?? null) : validAccount(line.chosen?.account)
      if (!entry.account) {
        entry.suggestedAccount = input.vatRegistered ? SETTLEMENT_INPUT_VAT_ACCOUNT : SETTLEMENT_FEE_ACCOUNT
        waitFor({ reason: 'vat_unconfirmed', position: line.position })
      }
    } else if (line.kind === 'unknown') {
      entry.account = validAccount(line.chosen?.account)
      if (!entry.account) waitFor({ reason: 'unknown_line', position: line.position })
    } else {
      entry.account = validAccount(line.chosen?.account) ?? SETTLEMENT_KIND_ACCOUNTS[line.kind] ?? null
      if (!entry.account) waitFor({ reason: 'unknown_line', position: line.position })
    }

    // VAT on the fee line itself, booked only when the settlement has no VAT line of its own.
    const bookLineVat = VAT_CARRYING_KINDS.has(line.kind) && taxAmount !== 0 && !hasVatLine
    if (bookLineVat) {
      entry.vatAccount = resolveVatAccount(input, line.chosen?.vatAccount ?? null)
      if (!entry.vatAccount) {
        entry.suggestedAccount = SETTLEMENT_INPUT_VAT_ACCOUNT
        waitFor({ reason: 'vat_unconfirmed', position: line.position })
      }
    }

    const direction = lineDirection(line)
    if (!direction) continue
    // A deducted kind credited back books on the credit side; any other
    // negative amount, and negative VAT, would flip a direction whose
    // meaning is unconfirmed, so a person looks at it.
    const creditedBack = lineAmount < 0 && DEBIT_KINDS.has(line.kind)
    if ((lineAmount < 0 && !creditedBack) || taxAmount < 0) {
      issues.push({ reason: 'unknown_line', position: line.position })
      continue
    }
    const side = creditedBack ? 'credit' : direction
    const sideAmount = creditedBack ? roundOre(-lineAmount) : lineAmount
    const text = lineText(line)
    if (side === 'credit') credits.push(sideAmount)
    else debits.push(sideAmount)
    if (entry.account && sideAmount > 0) {
      voucherLines.push({
        account_number: entry.account,
        debit_amount: side === 'debit' ? sideAmount : 0,
        credit_amount: side === 'credit' ? sideAmount : 0,
        line_description: text,
      })
    }
    if (sideAmount > 0) {
      draftRows.push({
        account: entry.account,
        waitsFor: entry.account ? null : { position: line.position, field: 'account' },
        debit: side === 'debit' ? sideAmount : 0,
        credit: side === 'credit' ? sideAmount : 0,
      })
    }
    if (bookLineVat && taxAmount > 0) {
      debits.push(taxAmount)
      draftRows.push({
        account: entry.vatAccount,
        waitsFor: entry.vatAccount ? null : { position: line.position, field: 'vatAccount' },
        debit: taxAmount,
        credit: 0,
      })
      if (entry.vatAccount) {
        voucherLines.push({
          account_number: entry.vatAccount,
          debit_amount: taxAmount,
          credit_amount: 0,
          line_description: `Moms, ${text}`.slice(0, 200),
        })
      }
    }
  }

  // Per case: the principal of each case group equals its collected payments not yet paid out.
  const settles: string[] = []
  const groups = new Map<string, { caseIds: readonly string[]; principal: number; positions: number[] }>()
  for (const line of sorted) {
    if (line.kind !== 'principal' || !lineIsBooked(line)) continue
    if (line.caseIds.length === 0) {
      issues.push({ reason: 'unknown_case', position: line.position })
      continue
    }
    const caseIds = [...new Set(line.caseIds)].sort()
    const key = caseIds.join(',')
    const group = groups.get(key) ?? { caseIds, principal: 0, positions: [] }
    group.principal = roundOre(group.principal + roundOre(line.amount))
    group.positions.push(line.position)
    groups.set(key, group)
  }
  const caseMismatch: Array<{ caseIds: readonly string[]; principal: number; available: number }> = []
  // A collected payment settles one group only: a case that appears both on
  // its own line and inside a merged line must not count its capital twice
  // (the clearing account would be credited for money it never held).
  const taken = new Set<string>()
  for (const group of groups.values()) {
    const ofGroup = input.collected.filter(
      (payment) => group.caseIds.includes(payment.caseId) && (payment.settlementId === null || payment.settlementId === input.settlementId),
    )
    const candidates = ofGroup.filter(
      (payment) => payment.status === 'booked' && payment.paidAt <= input.paymentDate && !taken.has(payment.id),
    )
    const matched = matchCollected(group.principal, candidates)
    if (matched) {
      for (const payment of matched) taken.add(payment.id)
      settles.push(...matched.map((payment) => payment.id))
      continue
    }
    const unbooked = ofGroup.some((payment) => payment.status === 'pending' || payment.status === 'needs_review')
    for (const position of group.positions) {
      issues.push({ reason: unbooked ? 'collected_payment_unbooked' : 'case_mismatch', position })
    }
    caseMismatch.push({
      caseIds: group.caseIds,
      principal: group.principal,
      available: sumOre(candidates.map((payment) => roundOre(payment.capitalPaid))),
    })
  }

  const creditTotal = sumOre(credits)
  const debitTotal = sumOre(debits)
  const linesTotal = roundOre(creditTotal - debitTotal)
  if (linesTotal !== amount) issues.push({ reason: 'unbalanced', position: null })

  if (issues.length > 0) {
    const reason = REASON_ORDER.find((candidate) => issues.some((issue) => issue.reason === candidate)) ?? issues[0]!.reason
    // Held only by choices a person makes (every issue is one of them): the voucher as it will book.
    const draft =
      waiting.length === issues.length
        ? [{ account: input.payoutAccount, waitsFor: null, debit: amount, credit: 0 }, ...draftRows]
        : null
    return {
      ok: false,
      reason,
      issues,
      lineAccounts,
      details: { linesTotal, amount, difference: roundOre(amount - linesTotal), ...(caseMismatch.length > 0 ? { caseMismatch } : {}) },
      draft,
    }
  }

  return {
    ok: true,
    lines: [
      { account_number: input.payoutAccount, debit_amount: amount, credit_amount: 0, line_description: 'Utbetalning från inkassobolaget' },
      ...voucherLines,
    ],
    lineAccounts,
    settles: [...new Set(settles)],
    credits: creditTotal,
    debits: debitTotal,
  }
}
