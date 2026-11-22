/**
 * The browser side of the signatory page (/koppla/[token]): the token routes
 * under /api/koppla/[token] answer the same shapes as the session routes, so
 * the bank calls are the OpenPaymentsApi bound to that base, and the payments
 * verification calls are the two below. The token is the credential: it
 * travels in the path, never in a header or a log line.
 */

import { PaymentsClientError, type CompanyVerification, type StartedVerification } from '@/components/payments/payments-client'
import type { FlowState } from './connect-flow-reducer'
import { createOpenPaymentsApi, openPaymentsSignatoryBase, type OpenPaymentsApi } from './open-payments-client'
import { normalizePersonalNumber } from './personal-number'
import type { BankConnectBackend, PaymentsOffer } from './use-bank-connect-controller'

async function send<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new PaymentsClientError(body, res.status)
  return (body as { data: T }).data
}

export interface SignatoryPaymentsApi {
  probe(): Promise<PaymentsOffer>
  fetchVerification(options?: { refresh?: boolean }): Promise<CompanyVerification>
  startVerification(options?: { handoff?: boolean }): Promise<StartedVerification>
}

/**
 * The payments verification through the token door. The probe reads the
 * company's verification status: a refusal (payments not switched on for the
 * company, no provider) means no offer; a provider hiccup, or the provider's
 * refusal to read the status (PAYMENT_PROVIDER_REFUSED, a 422), keeps the
 * offer with an unknown status, as the dialog does.
 */
export function createSignatoryPaymentsApi(base: string): SignatoryPaymentsApi {
  const fetchVerification = (options: { refresh?: boolean } = {}) =>
    send<CompanyVerification>(options.refresh ? `${base}/verification?refresh=1` : `${base}/verification`)
  return {
    async probe() {
      try {
        const verification = await fetchVerification()
        return { offered: verification.status !== 'valid', verification }
      } catch (error) {
        if (error instanceof PaymentsClientError && error.status !== 503 && error.status !== 502
          && error.code !== 'PAYMENT_PROVIDER_REFUSED') {
          return { offered: false, verification: null }
        }
        return { offered: true, verification: null }
      }
    },
    fetchVerification,
    // The firmatecknare is the one at the screen: the form is never handed off from here.
    startVerification() {
      return send<StartedVerification>(`${base}/verification/start`, { method: 'POST', body: JSON.stringify({}) })
    },
  }
}

/**
 * Where the typed personnummer waits while the firmatecknare signs on the
 * bank's own page: this tab's session storage, keyed by the link and the
 * connection, read once on the way back and removed. Nothing on file exists
 * for a person without an account, and the bank wants the PSU on the poll
 * and a restart as on the start; without this the calls after the return
 * would name nobody. Never the server, never local storage.
 */
function personalNumberKey(token: string, connectionId: string): string {
  return `koppla:pn:${token.slice(0, 8)}:${connectionId}`
}

export function keepSignatoryPersonalNumber(token: string, connectionId: string, personalNumber: string): void {
  const normalized = normalizePersonalNumber(personalNumber)
  if (!normalized) return
  try {
    window.sessionStorage.setItem(personalNumberKey(token, connectionId), normalized)
  } catch {
    // Storage blocked: the person types it again if the bank asks.
  }
}

/** The number kept before leaving for the bank, once; null when none was kept or storage is blocked. */
export function recallSignatoryPersonalNumber(token: string, connectionId: string): string | null {
  try {
    const key = personalNumberKey(token, connectionId)
    const value = window.sessionStorage.getItem(key)
    if (value) window.sessionStorage.removeItem(key)
    return value ? normalizePersonalNumber(value) : null
  } catch {
    return null
  }
}

/**
 * The doors of one signatory page. The firmatecknare has no account, so
 * nothing is on file: the personnummer is typed on the page every time, and
 * kept in this tab across a signing on the bank's own page.
 */
export function createSignatoryBackend(token: string, options: { offerPayments: boolean }): BankConnectBackend & { bank: OpenPaymentsApi } {
  const base = openPaymentsSignatoryBase(token)
  return {
    bank: createOpenPaymentsApi(base),
    payments: options.offerPayments ? createSignatoryPaymentsApi(base) : null,
    watchSignerKnown(onAnswer) {
      onAnswer(false)
      return () => {}
    },
    beforeLeavingForBank(connectionId: string, state: FlowState) {
      keepSignatoryPersonalNumber(token, connectionId, state.personalNumber)
    },
  }
}
