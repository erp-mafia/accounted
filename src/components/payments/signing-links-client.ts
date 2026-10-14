/**
 * The browser side of the payment signing link (lib/payments/orders/
 * signing-links.ts): the session calls behind Be någon annan signera on
 * Betalningar, and the token calls of the page a firmatecknare opens at
 * /betala/<token>. The token routes answer the same signing shapes as the
 * session routes, so the page drives the same BankIdSigningFlow through a
 * SigningClient bound to its token. The token is the credential: it travels
 * in the path, never in a header or a log line.
 */

import type { SigningClient } from './BankIdSigningFlow'
import { PaymentsClientError, psuAuthoriserBody, type PaymentOrderStatus, type SigningBatchStatus, type SigningView } from './payments-client'

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

// ---------------------------------------------------------------------------
// Session: Betalningar
// ---------------------------------------------------------------------------

export interface IssuedSigningLink {
  signing_link_id: string
  url: string
  expires_at: string
  email_sent: boolean
  order_count: number
  total_amount: number
  currency: string
}

/** GET /api/payments/signing-links: an open link, never its token. */
export interface OpenSigningLink {
  signing_link_id: string
  recipient_email: string | null
  payment_order_ids: string[]
  expires_at: string
  created_by: string
  created_at: string
  email_sent: boolean
}

export function issueSigningLink(input: { orderIds: string[]; recipientEmail: string | null; note: string | null }): Promise<IssuedSigningLink> {
  return send<IssuedSigningLink>('/api/payments/signing-links', {
    method: 'POST',
    body: JSON.stringify({ order_ids: input.orderIds, recipient_email: input.recipientEmail, note: input.note }),
  })
}

export function listOpenSigningLinks(): Promise<OpenSigningLink[]> {
  return send<OpenSigningLink[]>('/api/payments/signing-links')
}

export function cancelSigningLink(signingLinkId: string): Promise<{ signing_link_id: string; cancelled: true }> {
  return send<{ signing_link_id: string; cancelled: true }>(`/api/payments/signing-links/${signingLinkId}`, { method: 'DELETE' })
}

/** The open link covering each order, by order id. */
export function openLinksByOrder(links: readonly OpenSigningLink[]): Map<string, OpenSigningLink> {
  const byOrder = new Map<string, OpenSigningLink>()
  for (const link of links) for (const id of link.payment_order_ids) if (!byOrder.has(id)) byOrder.set(id, link)
  return byOrder
}

// ---------------------------------------------------------------------------
// Token: the page at /betala/<token>
// ---------------------------------------------------------------------------

export type SigningLinkState = 'ready' | 'in_signing' | 'done' | 'changed'

/** GET /api/betala/:token, and what the page is rendered with on the server. */
export interface SigningLinkPageData {
  state: SigningLinkState
  company_name: string
  requester: string
  note: string | null
  expires_at: string
  bank_name: string | null
  account: { name: string | null; iban: string | null }
  order_count: number
  total_amount: number
  currency: string
  orders: Array<{
    payment_order_id: string
    payee_name: string
    payee_label: string
    amount: number
    currency: string
    requested_execution_date: string
    reference_type: 'ocr' | 'message'
    reference: string
    status: PaymentOrderStatus
  }>
  signing: { batch_id: string; status: SigningBatchStatus } | null
}

export function signingLinkBase(token: string): string {
  return `/api/betala/${encodeURIComponent(token)}`
}

export function fetchSigningLinkBasket(token: string): Promise<SigningLinkPageData> {
  return send<SigningLinkPageData>(signingLinkBase(token))
}

/**
 * Where the typed personnummer waits while the firmatecknare signs on the
 * bank's own page: this tab's session storage, keyed by the link, read on the
 * way back. Nothing is on file for a person without an account, and the bank
 * wants the PSU on the poll as on the start; without this the poll after the
 * return would name nobody. Never the server, never local storage.
 */
function personalNumberKey(token: string): string {
  return `betala:pn:${token.slice(0, 8)}`
}

export function keepSigningLinkPersonalNumber(token: string, personalNumber: string | null): void {
  if (!personalNumber) return
  try {
    window.sessionStorage.setItem(personalNumberKey(token), personalNumber)
  } catch {
    // Storage blocked: the person types it again.
  }
}

export function recallSigningLinkPersonalNumber(token: string): string | null {
  try {
    return window.sessionStorage.getItem(personalNumberKey(token))
  } catch {
    return null
  }
}

export function forgetSigningLinkPersonalNumber(token: string): void {
  try {
    window.sessionStorage.removeItem(personalNumberKey(token))
  } catch {
    // Nothing kept.
  }
}

/** The BankIdSigningFlow's calls through the link's token routes. The link names the orders; the body never does. */
export function createSigningLinkClient(token: string): SigningClient {
  const base = signingLinkBase(token)
  return {
    verification: false,
    start(input) {
      keepSigningLinkPersonalNumber(token, input.personalNumber)
      return send<SigningView>(`${base}/signing`, {
        method: 'POST',
        body: JSON.stringify({ method: input.method, personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
      })
    },
    restart(input) {
      keepSigningLinkPersonalNumber(token, input.personalNumber)
      return send<SigningView>(`${base}/signing/${input.batchId}/restart`, {
        method: 'POST',
        body: JSON.stringify({ method: input.method, personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
      })
    },
    poll(input, signal) {
      return send<SigningView>(`${base}/signing/${input.batchId}/poll`, {
        method: 'POST',
        body: JSON.stringify({ personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
        signal,
      })
    },
  }
}
