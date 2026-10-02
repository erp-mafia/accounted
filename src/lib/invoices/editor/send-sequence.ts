import type { InvoiceDocumentType } from '@/types'

/**
 * The invoice editor's "send from the editor" sequence, behind the confirm
 * dialog: persist the form, then hand the saved document to the route that
 * sends it. Every step is an existing route with its own guards; this module
 * only orders them, so the editor and its tests agree on what a confirm does.
 *
 *  1. Persist.
 *     - New document: POST /api/invoices (a faktura or proforma gets its
 *       number here and invoice.created fires, exactly as "Skapa" always
 *       did; a quote or följesedel is numbered at insert).
 *     - Saved draft (edit mode): PATCH /api/invoices/{id}; an unnumbered
 *       faktura is then finalized (POST /finalize numbers it and emits
 *       invoice.created), the same step the detail page requires before a
 *       send.
 *  2. Send.
 *     - email:  POST /api/invoices/{id}/send, with this send's extra copies
 *               and its own subject and message when given.
 *     - manual: POST /api/invoices/{id}/mark-sent ("Jag skickar själv"; the
 *               caller downloads the archived PDF afterwards).
 *
 * A failure after step 1 still reports the saved document's id: it exists
 * now, and a retry from the editor would create a second one.
 */

export type SendSequenceChannel = 'email' | 'manual'

export interface SendEmailOptions {
  additional_cc?: string[]
  email_subject?: string
  email_body?: string
}

export interface SendSequenceInput {
  /** 'create' covers copy too. */
  mode: 'create' | 'edit'
  /** Edit mode: the draft being saved. */
  invoiceId?: string | null
  /** Edit mode: the draft's number; null = an unnumbered draft. */
  invoiceNumber?: string | null
  documentType: InvoiceDocumentType
  /** The write body (lib/invoices/editor-payload.ts buildInvoiceWritePayload). */
  payload: Record<string, unknown>
  channel: SendSequenceChannel
  email?: SendEmailOptions
}

export type SendSequenceStage = 'persist' | 'finalize' | 'send'

export type SendSequenceResult =
  | {
      ok: true
      invoiceId: string
      invoiceNumber: string | null
      /** The send went out but a follow-up (archive, periodisering, delivery history) failed. */
      partial: boolean
      message: string | null
    }
  | {
      ok: false
      stage: SendSequenceStage
      /** Set once the document exists (any failure after persist). */
      invoiceId: string | null
      status: number
      /** The parsed error body, for getErrorMessage. */
      error: unknown
    }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** Only the keys that carry something: an untouched send posts no body at all. */
export function buildSendBody(email: SendEmailOptions | undefined): Record<string, unknown> | null {
  if (!email) return null
  const body: Record<string, unknown> = {}
  if (email.additional_cc && email.additional_cc.length > 0) body.additional_cc = email.additional_cc
  if (email.email_subject && email.email_subject.trim()) body.email_subject = email.email_subject
  if (email.email_body && email.email_body.trim()) body.email_body = email.email_body
  return Object.keys(body).length > 0 ? body : null
}

export async function persistAndSend(
  input: SendSequenceInput,
  fetchImpl: FetchLike = fetch,
): Promise<SendSequenceResult> {
  // 1. Persist.
  let invoiceId: string
  let invoiceNumber: string | null
  if (input.mode === 'edit') {
    if (!input.invoiceId) {
      return { ok: false, stage: 'persist', invoiceId: null, status: 0, error: new Error('missing invoice id') }
    }
    const response = await fetchImpl(
      `/api/invoices/${encodeURIComponent(input.invoiceId)}`,
      jsonInit('PATCH', input.payload),
    )
    const result = await readJson(response)
    if (!response.ok) {
      return { ok: false, stage: 'persist', invoiceId: null, status: response.status, error: result }
    }
    invoiceId = input.invoiceId
    invoiceNumber = input.invoiceNumber ?? null
    if (input.documentType === 'invoice' && !invoiceNumber) {
      const finalize = await fetchImpl(`/api/invoices/${encodeURIComponent(invoiceId)}/finalize`, {
        method: 'POST',
      })
      const finalized = await readJson(finalize)
      if (!finalize.ok) {
        return { ok: false, stage: 'finalize', invoiceId, status: finalize.status, error: finalized }
      }
      const data = finalized?.data as { invoice_number?: string | null } | undefined
      invoiceNumber = data?.invoice_number ?? null
    }
  } else {
    const response = await fetchImpl('/api/invoices', jsonInit('POST', input.payload))
    const result = await readJson(response)
    const data = result?.data as { id?: string; invoice_number?: string | null } | undefined
    if (!response.ok || !data?.id) {
      return { ok: false, stage: 'persist', invoiceId: null, status: response.status, error: result }
    }
    invoiceId = data.id
    invoiceNumber = data.invoice_number ?? null
  }

  // 2. Send.
  const route = input.channel === 'email' ? 'send' : 'mark-sent'
  const body = input.channel === 'email' ? buildSendBody(input.email) : null
  const sendResponse = await fetchImpl(
    `/api/invoices/${encodeURIComponent(invoiceId)}/${route}`,
    body ? jsonInit('POST', body) : { method: 'POST' },
  )
  const sent = await readJson(sendResponse)
  if (!sendResponse.ok) {
    return { ok: false, stage: 'send', invoiceId, status: sendResponse.status, error: sent }
  }
  return {
    ok: true,
    invoiceId,
    invoiceNumber,
    partial: sent?.partial === true,
    message: typeof sent?.message === 'string' ? sent.message : null,
  }
}
