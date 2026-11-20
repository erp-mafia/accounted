/**
 * Uppskjuten skatt in a K3 legal entity (BFNAR 2012:1 kap. 29). Pure.
 *
 * A temporary difference is the difference between an item's carrying amount
 * and its tax value (29.14): for an asset, carrying above tax value is
 * taxable (a deferred tax liability), below it deductible (a deferred tax
 * asset); for a liability the other way round. A tax loss carried forward is
 * a deductible difference with no carrying amount (29.19 c). Deferred tax is
 * the difference at the tax rate decided before the balansdag (29.25),
 * undiscounted.
 *
 * Not here, on purpose: obeskattade reserver. In the legal entity their tax
 * stays inside the gross reserve (29.37), so the 2026-08-05 removal of the
 * reserves split stands, and an IL 18 kap. pool under räkenskapsenlig
 * avskrivning has no other difference: its tax value is the book value less
 * the reserve.
 *
 * The balance is presented net, as a liability on 2240 or an asset on 1370:
 * a Swedish company's taxes are levied by one authority and settled net, the
 * legal right of offset of 29.32.
 */
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

export type DeferredTaxKind = 'loss_carryforward' | 'building' | 'manual'

export const DEFERRED_TAX_EXPENSE_ACCOUNT = '8940'
export const DEFERRED_TAX_LIABILITY_ACCOUNT = '2240'
export const DEFERRED_TAX_ASSET_ACCOUNT = '1370'

/** An item with a carrying amount and a tax value (29.14-29.18). */
export interface TemporaryDifferenceInput {
  kind: DeferredTaxKind
  label: string
  /** Asset or liability: decides which way the difference is taxable. */
  nature: 'asset' | 'liability'
  carryingAmount: number
  taxValue: number
  /** K3 29.29: why a recognised loss carried forward is expected to be used. */
  reason?: string | null
}

/** One row of deferred_tax_items, as commit_deferred_tax takes it. */
export interface DeferredTaxItem {
  kind: DeferredTaxKind
  label: string
  carrying_amount: number
  tax_value: number
  /** Positive: taxable (a liability); negative: deductible (an asset). */
  temporary_difference: number
  tax_rate: number
  /** Positive: a deferred tax liability; negative: an asset. */
  deferred_tax: number
  /**
   * A recognised loss carried forward: the 29.29 judgement as it stood when
   * the voucher posted, kept on the immutable item (the assessment stays
   * editable).
   */
  reason?: string
}

/** The temporary difference of an item: positive taxable, negative deductible. */
export function temporaryDifference(input: Pick<TemporaryDifferenceInput, 'nature' | 'carryingAmount' | 'taxValue'>): number {
  const difference = input.nature === 'asset'
    ? input.carryingAmount - input.taxValue
    : input.taxValue - input.carryingAmount
  return roundOre(difference)
}

export function deferredTaxItem(input: TemporaryDifferenceInput, rate: number): DeferredTaxItem {
  const difference = temporaryDifference(input)
  const reason = input.reason?.trim()
  return {
    kind: input.kind,
    label: input.label.trim(),
    carrying_amount: roundOre(input.carryingAmount),
    tax_value: roundOre(input.taxValue),
    temporary_difference: difference,
    tax_rate: rate,
    deferred_tax: roundOre(difference * rate),
    ...(reason ? { reason } : {}),
  }
}

/**
 * A tax loss carried forward as a deductible difference (29.19 c), with the
 * 29.29 reason it is recognised.
 */
export function lossCarryforwardDifference(deficit: number, reason?: string | null): TemporaryDifferenceInput {
  return {
    kind: 'loss_carryforward',
    label: 'Underskottsavdrag',
    nature: 'asset',
    carryingAmount: 0,
    taxValue: roundOre(deficit),
    reason: reason ?? null,
  }
}

/** The deferred tax on the balansdag: positive a liability, negative an asset. */
export function closingDeferredTax(items: readonly DeferredTaxItem[]): number {
  return roundOre(items.reduce((sum, item) => sum + item.deferred_tax, 0))
}

/** What the ledger holds before the posting, as balances on the two accounts. */
export interface DeferredTaxBalances {
  /** 2240: credit balance. */
  liability: number
  /** 1370: debit balance. */
  asset: number
}

export interface DeferredTaxPosting {
  /** The net deferred tax the ledger holds: liability less asset. */
  opening: number
  closing: number
  /** closing - opening; positive is a cost on 8940. */
  change: number
  lines: CreateJournalEntryLineInput[]
}

/**
 * The voucher that takes the ledger from what it holds to the closing
 * deferred tax, presented net (29.32): a net liability on 2240 and nothing
 * on 1370, or the reverse; the change against 8940 (29.22: in the income
 * statement, there being no item here recognised in equity).
 */
export function deferredTaxPosting(balances: DeferredTaxBalances, closing: number): DeferredTaxPosting {
  const opening = roundOre(balances.liability - balances.asset)
  const target = { liability: Math.max(0, closing), asset: Math.max(0, -closing) }
  const change = roundOre(closing - opening)
  const lines: CreateJournalEntryLineInput[] = []
  const liabilityMove = roundOre(target.liability - balances.liability)
  const assetMove = roundOre(target.asset - balances.asset)
  if (Math.abs(change) >= 0.005) {
    lines.push({
      account_number: DEFERRED_TAX_EXPENSE_ACCOUNT,
      debit_amount: change > 0 ? change : 0,
      credit_amount: change < 0 ? -change : 0,
      line_description: change > 0 ? 'Uppskjuten skattekostnad' : 'Uppskjuten skatteintäkt',
    })
  }
  if (Math.abs(liabilityMove) >= 0.005) {
    lines.push({
      account_number: DEFERRED_TAX_LIABILITY_ACCOUNT,
      debit_amount: liabilityMove < 0 ? -liabilityMove : 0,
      credit_amount: liabilityMove > 0 ? liabilityMove : 0,
      line_description: 'Avsättning för uppskjuten skatt',
    })
  }
  if (Math.abs(assetMove) >= 0.005) {
    lines.push({
      account_number: DEFERRED_TAX_ASSET_ACCOUNT,
      debit_amount: assetMove > 0 ? assetMove : 0,
      credit_amount: assetMove < 0 ? -assetMove : 0,
      line_description: 'Uppskjuten skattefordran',
    })
  }
  return { opening, closing: roundOre(closing), change, lines }
}
