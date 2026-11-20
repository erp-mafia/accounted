/**
 * Reading the query string a page lands with: the second signatory's
 * reminder link (`?bank_connect=<id>`), the renewal mail's deep link
 * (`?bank_connect=<id>&renew=1`, lib/bank-feed/cron.ts renewalDeepLink), the
 * return from a bank that signs on its own page
 * (`?bank_connect=<id>&state=<id>&result=ok|error&code=...`,
 * lib/bank-feed/return-url.ts) and an agent's connect link
 * (`?bank_connect=new[&bic=SWEDSESS]`, gnubok_connect_bank), which opens
 * Koppla banken for a new connection with that bank preselected. Pure, so it
 * is tested without React; the resume hook turns the answer into the flow
 * and strips the parameters.
 */

import { BANK_CONNECT_RETURN_PARAM } from '@/lib/bank-feed/return-url'
import type { FlowReturn } from './connect-flow-reducer'

/** The `bank_connect` value that names no connection but asks for a new one. */
export const BANK_CONNECT_NEW = 'new'

/** The `bic` parameter beside `bank_connect=new`: the bank to preselect, as the MCP tool resolved it. */
export const BANK_CONNECT_BIC_PARAM = 'bic'

const BIC = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/

/** Every parameter a return may carry; all are removed from the URL once read. */
export const BANK_CONNECT_RETURN_QUERY_PARAMS = [BANK_CONNECT_RETURN_PARAM, 'state', 'result', 'code', 'renew', BANK_CONNECT_BIC_PARAM] as const

export interface BankConnectNew {
  /** The bank to preselect, upper case, or null for the picker (no bic, or a malformed one). */
  bic: string | null
}

/**
 * The agent's connect link, or null when the URL does not carry
 * `bank_connect=new`. A malformed bic opens the picker rather than nothing:
 * the person asked to connect a bank, the preselection is a convenience.
 */
export function parseBankConnectNew(params: { get(name: string): string | null }): BankConnectNew | null {
  if (params.get(BANK_CONNECT_RETURN_PARAM) !== BANK_CONNECT_NEW) return null
  const bic = params.get(BANK_CONNECT_BIC_PARAM)?.trim().toUpperCase() ?? ''
  return { bic: BIC.test(bic) ? bic : null }
}

/** What the bank list says about a bank; the shape the picker hands the flow (connect-flow-reducer FlowBank). */
export interface PreselectableBank {
  bic: string
  name: string
  decoupled: boolean | null
  redirect: boolean | null
}

/**
 * The bank option the picker would hand the flow for this BIC, or null for
 * the open picker: an unknown BIC, or a bank list not loaded yet.
 */
export function preselectedBank<T extends PreselectableBank>(bic: string | null, banks: readonly T[] | null): PreselectableBank | null {
  if (!bic || !banks) return null
  const bank = banks.find((b) => b.bic === bic)
  return bank ? { bic: bank.bic, name: bank.name, decoupled: bank.decoupled, redirect: bank.redirect } : null
}

export interface BankConnectReturn {
  connectionId: string
  /** Null for a plain resume (the reminder link). */
  returned: FlowReturn | null
  /** The renewal mail's link: open Koppla banken in renew mode for this connection instead of resuming its BankID. */
  renew: boolean
}

/**
 * The connection to resume, or null when the URL names none. `state` names
 * the connection only together with `result` (the bank's return always
 * carries both); alone it could be another flow's OAuth state.
 */
export function parseBankConnectReturn(params: { get(name: string): string | null }): BankConnectReturn | null {
  const rawResult = params.get('result')
  const result = rawResult === 'ok' || rawResult === 'error' ? rawResult : null
  const connectionId = params.get(BANK_CONNECT_RETURN_PARAM) ?? (result ? params.get('state') : null)
  // `new` names no connection: parseBankConnectNew reads that link.
  if (!connectionId || connectionId === BANK_CONNECT_NEW) return null
  // A renewal is never a return from the bank: the flag wins over a stray result.
  if (params.get('renew') === '1') return { connectionId, returned: null, renew: true }
  if (!result) return { connectionId, returned: null, renew: false }
  const code = result === 'error' ? (params.get('code')?.trim().toUpperCase().slice(0, 64) || null) : null
  return { connectionId, returned: { result, code }, renew: false }
}

/** The URL without the return parameters, for history.replaceState. */
export function stripBankConnectReturn(href: string): string {
  const url = new URL(href)
  for (const name of BANK_CONNECT_RETURN_QUERY_PARAMS) url.searchParams.delete(name)
  return url.pathname + url.search + url.hash
}
