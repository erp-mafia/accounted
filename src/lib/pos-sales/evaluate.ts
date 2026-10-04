import type { PosDay, PosTenderKind } from '@accounted/connect-contract'
import type { CreateJournalEntryLineInput } from '@/types'
import type { PosSalesSettings } from './settings'

/**
 * Provider-neutral: from a POS day (the contract's model) and the
 * connection's settings to the day's status and its daily takings voucher.
 * Pure, so the booking, the list, the preview and the tests all agree.
 *
 * The voucher (gemensam verifikation, BFL 5 kap 6 §; BFNAR 2013:2 p. 6.10
 * wants the split between cash and card visible in it):
 *
 *   debit   each way of paying, on its account, one line per kind and method
 *   credit  sales per VAT rate, net, on the rate's revenue account
 *   credit  output VAT per rate
 *   credit  tips, on the tips account (paid on top of sales)
 *   either  a rounding difference up to max_rounding, on the rounding account
 *
 * Negative amounts (a day with more refunds than sales on some line) swap
 * sides, so every line has exactly one positive side.
 */

export type PosReviewCode =
  | 'tender_unmapped'
  | 'vat_rate_unmapped'
  | 'not_balanced'
  | 'payments_without_sales'
  | 'provider_issue'

export interface PosReviewReason {
  code: PosReviewCode
  /** Values the UI interpolates; never prose. */
  params: Record<string, string | number>
  /** For provider_issue: the service's own wording (Swedish), shown as is. */
  message?: string
}

export type PosDayStatus = 'ready' | 'needs_review' | 'empty'

export interface PosDayEvaluation {
  status: PosDayStatus
  reasons: PosReviewReason[]
  /** True when every reason is a provider issue: a person may book after reading the report. */
  acknowledgeable: boolean
}

export interface PosDayEntry {
  lines: CreateJournalEntryLineInput[]
  /** Signed, kronor: positive = credited to the rounding account. */
  roundingAmount: number
  /** Reasons the voucher cannot be built; empty when `lines` balance. */
  problems: PosReviewReason[]
}

const TENDER_LABELS: Record<PosTenderKind, string> = {
  card: 'Kortbetalningar',
  swish: 'Swish',
  cash: 'Kontant',
  gift_card: 'Inlösta presentkort',
  invoice: 'Fakturabetalningar',
  prepaid: 'Förbetalt',
  other: 'Betalsätt',
}

function ore(amount: number): number {
  return Math.round(amount * 100)
}

function kronor(amountOre: number): number {
  return amountOre / 100
}

function rateKey(ratePercent: number): string {
  return String(ratePercent)
}

/** A signed amount as one journal line on the side its sign says. */
function line(
  accountNumber: string,
  side: 'debit' | 'credit',
  amountOre: number,
  description: string,
): CreateJournalEntryLineInput | null {
  if (amountOre === 0) return null
  const effectiveSide = amountOre > 0 ? side : side === 'debit' ? 'credit' : 'debit'
  const amount = kronor(Math.abs(amountOre))
  return {
    account_number: accountNumber,
    debit_amount: effectiveSide === 'debit' ? amount : 0,
    credit_amount: effectiveSide === 'credit' ? amount : 0,
    line_description: description,
  }
}

function isEmptyDay(day: PosDay): boolean {
  return ore(day.sales.gross) === 0 && ore(day.tips) === 0 && day.tenders.every((t) => ore(t.amount) === 0)
}

export function buildPosDayEntry(day: PosDay, settings: PosSalesSettings): PosDayEntry {
  const lines: CreateJournalEntryLineInput[] = []
  const problems: PosReviewReason[] = []
  const push = (l: CreateJournalEntryLineInput | null) => {
    if (l) lines.push(l)
  }

  for (const tender of day.tenders) {
    const amountOre = ore(tender.amount)
    if (amountOre === 0) continue
    const account = settings.tender_accounts[tender.kind]
    if (!account) {
      problems.push({ code: 'tender_unmapped', params: { kind: tender.kind, method: tender.method, amount: tender.amount } })
      continue
    }
    const label = tender.kind === 'other' ? `${TENDER_LABELS.other} ${tender.method}` : TENDER_LABELS[tender.kind]
    push(line(account, 'debit', amountOre, label))
  }

  for (const group of day.vatGroups) {
    const key = rateKey(group.ratePercent)
    const revenueAccount = (settings.revenue_accounts as Record<string, string | null>)[key] ?? null
    const vatAccount = group.ratePercent === 0 ? null : (settings.vat_accounts as Record<string, string | null>)[key] ?? null
    const netOre = ore(group.net)
    const vatOre = ore(group.vat)
    if (!revenueAccount || (vatOre !== 0 && !vatAccount)) {
      if (netOre !== 0 || vatOre !== 0) {
        problems.push({ code: 'vat_rate_unmapped', params: { rate: group.ratePercent, gross: group.gross } })
      }
      continue
    }
    push(line(revenueAccount, 'credit', netOre, group.ratePercent === 0 ? 'Försäljning utan moms' : `Försäljning ${group.ratePercent} % moms`))
    if (vatAccount) push(line(vatAccount, 'credit', vatOre, `Utgående moms ${group.ratePercent} %`))
  }

  push(line(settings.tips_account, 'credit', ore(day.tips), 'Dricks att betala ut till personalen'))

  if (problems.length > 0) return { lines: [], roundingAmount: 0, problems }

  const debitOre = lines.reduce((sum, l) => sum + ore(l.debit_amount), 0)
  const creditOre = lines.reduce((sum, l) => sum + ore(l.credit_amount), 0)
  const differenceOre = debitOre - creditOre
  if (differenceOre !== 0) {
    if (Math.abs(differenceOre) > ore(settings.max_rounding)) {
      return { lines: [], roundingAmount: 0, problems: [{ code: 'not_balanced', params: { difference: kronor(differenceOre) } }] }
    }
    push(line(settings.rounding_account, 'credit', differenceOre, 'Öres- och kronutjämning'))
  }
  if (lines.length === 0 || lines.every((l) => ore(l.debit_amount) === 0) || lines.every((l) => ore(l.credit_amount) === 0)) {
    return { lines: [], roundingAmount: 0, problems: [{ code: 'payments_without_sales', params: { amount: kronor(debitOre) } }] }
  }
  return { lines, roundingAmount: kronor(differenceOre), problems: [] }
}

export function evaluatePosDay(day: PosDay, settings: PosSalesSettings): PosDayEvaluation {
  if (isEmptyDay(day)) return { status: 'empty', reasons: [], acknowledgeable: false }

  const reasons: PosReviewReason[] = []
  if (ore(day.sales.gross) === 0) {
    reasons.push({ code: 'payments_without_sales', params: { amount: day.tenders.reduce((s, t) => s + t.amount, 0) } })
  }
  const entry = buildPosDayEntry(day, settings)
  for (const problem of entry.problems) {
    if (!reasons.some((r) => r.code === problem.code && JSON.stringify(r.params) === JSON.stringify(problem.params))) {
      reasons.push(problem)
    }
  }
  const blocking = reasons.length
  for (const issue of day.issues) {
    reasons.push({ code: 'provider_issue', params: { code: issue.code }, message: issue.message })
  }
  if (reasons.length === 0) return { status: 'ready', reasons: [], acknowledgeable: false }
  return { status: 'needs_review', reasons, acknowledgeable: blocking === 0 }
}

/** The voucher text: what, when, where, and from which system. */
export function posDayDescription(day: Pick<PosDay, 'businessDate'>, venueName: string, providerName: string): string {
  return `Dagskassa ${day.businessDate} ${venueName} (${providerName})`
}
