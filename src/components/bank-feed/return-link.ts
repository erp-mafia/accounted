/**
 * Reading the query string a page lands with: the second signatory's
 * reminder link (`?bank_connect=<id>`), the renewal mail's deep link
 * (`?bank_connect=<id>&renew=1`, lib/bank-feed/cron.ts renewalDeepLink) and
 * the return from a bank that signs on its own page
 * (`?bank_connect=<id>&state=<id>&result=ok|error&code=...`,
 * lib/bank-feed/return-url.ts). Pure, so it is tested without React; the
 * resume hook turns the answer into the flow and strips the parameters.
 */

import { BANK_CONNECT_RETURN_PARAM } from '@/lib/bank-feed/return-url'
import type { FlowReturn } from './connect-flow-reducer'

/** Every parameter a return may carry; all are removed from the URL once read. */
export const BANK_CONNECT_RETURN_QUERY_PARAMS = [BANK_CONNECT_RETURN_PARAM, 'state', 'result', 'code', 'renew'] as const

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
  if (!connectionId) return null
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
