/**
 * What the bank list's search finds: the banks by name (and the brand aliases
 * of lib/bank-sync/bank-search.ts), and the sparbanker reached through a
 * shared BIC (Swedbank's), so a savings bank is found from the one search
 * instead of behind a second list. Pure, so the matching and the dialog state
 * a result leads to are tested without React.
 */

import { bankMatchesQuery } from '@/lib/bank-sync/bank-search'
import { orderBanks } from './bank-help'
import type { FlowAction, FlowAffiliate, FlowBank } from './connect-flow-reducer'
import type { OpenPaymentsBank } from './open-payments-client'

/** The BIC shared by Swedbank and the sparbanker behind it. */
export const SPARBANK_PARENT_BIC = 'SWEDSESS'

/** The sparbanker of one bank, as that bank's details list them. */
export interface SparbankGroup {
  parent: OpenPaymentsBank
  affiliates: ReadonlyArray<FlowAffiliate>
}

export type BankSearchRow =
  | { kind: 'bank'; bank: OpenPaymentsBank }
  | { kind: 'affiliate'; parent: OpenPaymentsBank; affiliate: FlowAffiliate }

/** Lowercase, diacritics folded ("Bjursås" and "bjuras" are the same word), single spaces. */
export function foldForSearch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Whether `query` occurs anywhere in `name`, ignoring case and diacritics. An empty query matches. */
export function nameMatchesQuery(name: string, query: string): boolean {
  const q = foldForSearch(query)
  return q === '' || foldForSearch(name).includes(q)
}

/** Whether this list entry stands for the bank and its sparbanker (the shared BIC). */
export function standsForSparbanker(bank: Pick<OpenPaymentsBank, 'bic'>): boolean {
  return bank.bic.trim().toUpperCase().slice(0, 8) === SPARBANK_PARENT_BIC
}

/** The list entry the sparbanker details belong to, or null when the list has none. */
export function sparbankParent(banks: readonly OpenPaymentsBank[]): OpenPaymentsBank | null {
  return banks.find(standsForSparbanker) ?? null
}

/**
 * The rows of the bank list for `query`. An empty query is the list as it
 * always was: the banks, popular first. A query adds the sparbanker whose
 * names contain it after the banks it finds. The parent bank itself, which
 * the provider also lists among the affiliates, is not repeated.
 */
export function searchBankRows(banks: readonly OpenPaymentsBank[], sparbanker: SparbankGroup | null, query: string): BankSearchRow[] {
  const rows: BankSearchRow[] = orderBanks(banks.filter((bank) => bankMatchesQuery(bank, query) || nameMatchesQuery(bank.name, query))).map((bank) => ({ kind: 'bank', bank }))
  if (!sparbanker || foldForSearch(query) === '') return rows
  const parentName = foldForSearch(sparbanker.parent.name)
  const found = [...sparbanker.affiliates]
    .filter((affiliate) => foldForSearch(affiliate.name) !== parentName && nameMatchesQuery(affiliate.name, query))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'))
  return [...rows, ...found.map((affiliate): BankSearchRow => ({ kind: 'affiliate', parent: sparbanker.parent, affiliate }))]
}

/** The bank as the flow keeps it, exactly as picking its row in the dialog stores it. */
export function flowBankFromList(bank: OpenPaymentsBank): FlowBank {
  return { bic: bank.bic, name: bank.name, decoupled: bank.decoupled, redirect: bank.redirect }
}

/**
 * The actions a sparbank result stands for: choosing the bank behind the
 * shared BIC, then the sparbank, which is what the person does today with
 * the bank row and the "Vilken sparbank?" list.
 */
export function actionsForAffiliateResult(parent: OpenPaymentsBank, affiliate: FlowAffiliate): FlowAction[] {
  return [
    { type: 'bank_picked', bank: flowBankFromList(parent) },
    { type: 'affiliate_picked', affiliate },
  ]
}
