/**
 * The manual periodiseringar of a year-end close, the one model both
 * entry points share: the bokslut wizard's Periodiseringar step
 * (components/bookkeeping/year-end/AccrualsStep) and the periodisering
 * page (bookkeeping/year-end/periodisering). Each entry starts from a
 * PERIODISERING_TEMPLATES template (accounts pre-filled, editable) and maps
 * onto one POST /api/bookkeeping/fiscal-periods/{id}/accruals item; the
 * route puts a dimension bag on the result leg (the secondary account).
 */
import { parseAmountInput } from '@/lib/money'
import { PERIODISERING_TEMPLATES, type PeriodiseringTemplate } from './templates'

export interface ManualAccrualEntry {
  id: string
  templateKind: PeriodiseringTemplate['kind']
  amount: string
  description: string
  /** The balance-sheet leg: 17xx for a prepaid cost, 29xx otherwise. */
  primaryAccount: string
  /** The result leg: the cost account, or the revenue account for deferred revenue. */
  secondaryAccount: string
  /** Kostnadsställe/projekt for the result leg. */
  dimensions?: Record<string, string>
}

/** The bokslut / revision fee accrued at year end (2991 bokslut, 2992 revision). */
export interface AuditFeeState {
  enabled: boolean
  amount: string
  liabilityAccount: '2991' | '2992'
}

export type AccrualPostItem =
  | { kind: 'vacation_liability_change' }
  | { kind: 'audit_fee'; amount: number; liability_account: '2991' | '2992' }
  | {
      kind: 'manual_prepaid_expense'
      amount: number
      expense_account: string
      prepaid_account: string
      description: string
      dimensions?: Record<string, string>
    }
  | {
      kind: 'manual_accrued_expense' | 'accrued_interest' | 'accrued_utility'
      amount: number
      expense_account: string
      accrued_account: string
      description: string
      dimensions?: Record<string, string>
    }
  | {
      kind: 'deferred_revenue'
      amount: number
      revenue_account: string
      deferred_account: string
      description: string
      dimensions?: Record<string, string>
    }

export function templateOf(kind: PeriodiseringTemplate['kind']): PeriodiseringTemplate | undefined {
  return PERIODISERING_TEMPLATES.find((t) => t.kind === kind)
}

/** A new entry from a template, its accounts pre-filled. */
export function newManualAccrualEntry(template: PeriodiseringTemplate, id: string): ManualAccrualEntry {
  return {
    id,
    templateKind: template.kind,
    amount: '',
    description: '',
    primaryAccount: template.prepaid_account ?? template.deferred_account ?? template.accrued_account ?? '',
    secondaryAccount: template.expense_account ?? template.revenue_account ?? '',
  }
}

/** A positive amount typed in the form, or null. */
function positiveAmount(raw: string): number | null {
  const amount = parseAmountInput(raw)
  return amount !== null && amount > 0 ? amount : null
}

/**
 * The POST item for one manual entry, or null when it is not ready: no
 * positive amount, no description, or a missing account. A null entry is
 * left out of the post, as both forms always did.
 */
export function manualEntryToItem(entry: ManualAccrualEntry): AccrualPostItem | null {
  const amount = positiveAmount(entry.amount)
  const description = entry.description.trim()
  const primary = entry.primaryAccount.trim()
  const secondary = entry.secondaryAccount.trim()
  const template = templateOf(entry.templateKind)
  if (amount === null || !description || !primary || !secondary || !template) return null
  const dims = entry.dimensions && Object.keys(entry.dimensions).length > 0 ? { dimensions: entry.dimensions } : {}
  switch (template.side) {
    case 'prepaid':
      return { kind: 'manual_prepaid_expense', amount, expense_account: secondary, prepaid_account: primary, description, ...dims }
    case 'accrued':
      return { kind: 'manual_accrued_expense', amount, expense_account: secondary, accrued_account: primary, description, ...dims }
    case 'accrued_interest':
      return { kind: 'accrued_interest', amount, expense_account: secondary, accrued_account: primary, description, ...dims }
    case 'accrued_utility':
      return { kind: 'accrued_utility', amount, expense_account: secondary, accrued_account: primary, description, ...dims }
    case 'deferred_revenue':
      return { kind: 'deferred_revenue', amount, revenue_account: secondary, deferred_account: primary, description, ...dims }
  }
}

/** The items for the vacation change, the fee and the manual entries, in that order. */
export function buildAccrualItems(input: {
  vacation: boolean
  auditFee?: AuditFeeState | null
  manual: readonly ManualAccrualEntry[]
}): AccrualPostItem[] {
  const items: AccrualPostItem[] = []
  if (input.vacation) items.push({ kind: 'vacation_liability_change' })
  const fee = input.auditFee
  if (fee?.enabled) {
    const amount = positiveAmount(fee.amount)
    if (amount !== null) items.push({ kind: 'audit_fee', amount, liability_account: fee.liabilityAccount })
  }
  for (const entry of input.manual) {
    const item = manualEntryToItem(entry)
    if (item) items.push(item)
  }
  return items
}
