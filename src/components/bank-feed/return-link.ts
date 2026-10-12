/**
 * Reading the query string a page lands with: the second signatory's
 * reminder link (`?bank_connect=<id>`) and the return from a bank that signs
 * on its own page (`?bank_connect=<id>&state=<id>&result=ok|error&code=...`,
 * lib/bank-feed/return-url.ts). Pure, so it is tested without React; the
 * resume hook turns the answer into the flow and strips the parameters.
 */

import { BANK_CONNECT_RETURN_PARAM } from '@/lib/bank-feed/return-url'
import type { FlowReturn } from './connect-flow-reducer'

/** Every parameter a return may carry; all are removed from the URL once read. */
export const BANK_CONNECT_RETURN_QUERY_PARAMS = [BANK_CONNECT_RETURN_PARAM, 'state', 'result', 'code'] as const

export interface BankConnectReturn {
  connectionId: string
  /** Null for a plain resume (the reminder link). */
  returned: FlowReturn | null
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
  if (!result) return { connectionId, returned: null }
  const code = result === 'error' ? (params.get('code')?.trim().toUpperCase().slice(0, 64) || null) : null
  return { connectionId, returned: { result, code } }
}

/** The URL without the return parameters, for history.replaceState. */
export function stripBankConnectReturn(href: string): string {
  const url = new URL(href)
  for (const name of BANK_CONNECT_RETURN_QUERY_PARAMS) url.searchParams.delete(name)
  return url.pathname + url.search + url.hash
}
