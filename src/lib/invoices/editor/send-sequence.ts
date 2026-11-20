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
 *  2. Attach (email and Peppol, #79, crm#1545): the files picked in the confirm
 *     before the document existed are already in the archive (uploaded
 *     there as they were picked); POST /api/invoices/{id}/attachments links
 *     them to the saved draft, the same route the invoice page's send
 *     dialog links through. A refusal stops here, before anything is sent
 *     or booked, and reports the saved draft like any later failure.
 *  3. Send.
 *     - email:  POST /api/invoices/{id}/send, with this send's extra copies
 *               and its own subject and message when given.
 *     - manual: POST /api/invoices/{id}/mark-sent ("Jag skickar själv"; the
 *               caller downloads the archived PDF afterwards).
 *     - peppol: POST /api/invoices/{id}/peppol/send (the e-faktura through
 *               the company's access point; never a mark-sent).
 *     - kivra, billo: POST /api/invoices/{id}/digital-mailbox/send with
 *               { provider } (the PDF to the customer's mailbox; the route
 *               issues and books the faktura after its own checks, like
 *               the Peppol send).
 *     Kontantfaktura (paidAtIssue, crm#1281): POST /mark-sent with
 *     paid_at_issue whatever the channel, so the invoice is issued paid as
 *     one cash verifikat; then
 *  4. Receipt (email channel only): POST /send-payment-confirmation mails
 *     the paid invoice (BETALD) as the customer's receipt. The invoice is
 *     issued and booked by then, so a failure here is reported, not undone:
 *     the detail page sends the receipt again.
 *
 * A failure after step 1 still reports the saved document's id: it exists
 * now, and a retry from the editor would create a second one. That holds for
 * a request that never gets an answer too (offline, a dropped connection): a
 * rejected fetch is reported as a failed step with status 0, never thrown,
 * so the caller's "saved but not sent" path always runs.
 */

export type SendSequenceChannel = 'email' | 'manual' | 'peppol' | 'kivra' | 'billo'

const SEND_ROUTES: Record<SendSequenceChannel, string> = {
  email: 'send',
  manual: 'mark-sent',
  peppol: 'peppol/send',
  kivra: 'digital-mailbox/send',
  billo: 'digital-mailbox/send',
}

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
  /** Kontantfaktura: issue it already paid to this 19xx account (crm#1281). */
  paidAtIssue?: { account_number: string } | null
  /**
   * Archived documents sent with the invoice (#79): after the PDF in an
   * email, embedded in an e-faktura (crm#1545). Linked to the saved draft
   * before the send; the other channels do not carry them.
   */
  attachmentDocumentIds?: string[]
}

export type SendSequenceStage = 'persist' | 'finalize' | 'attach' | 'send'

export type SendSequenceResult =
  | {
      ok: true
      invoiceId: string
      invoiceNumber: string | null
      /** The send went out but a follow-up (archive, periodisering, delivery history) failed. */
      partial: boolean
      message: string | null
      /** Kontantfaktura by email: the invoice is issued paid, but the receipt mail failed. */
      receiptFailed?: boolean
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

/** One step's answer: the parsed body, or why the step failed. */
type StepReply =
  | { ok: true; status: number; json: Record<string, unknown> | null }
  | { ok: false; status: number; error: unknown }

/**
 * One step's request. A non-2xx answer fails with its parsed body; a fetch
 * that rejects (no network, aborted) fails with status 0 and the thrown
 * error, so no step can escape the result type.
 */
async function step(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<StepReply> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    return { ok: false, status: 0, error }
  }
  const json = await readJson(response)
  return response.ok
    ? { ok: true, status: response.status, json }
    : { ok: false, status: response.status, error: json }
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

/**
 * The send step's body: this send's email texts on the email channel, the
 * provider on a mailbox channel (the route reads it), none otherwise.
 */
export function buildSendStepBody(
  channel: SendSequenceChannel,
  email: SendEmailOptions | undefined,
): Record<string, unknown> | null {
  if (channel === 'email') return buildSendBody(email)
  if (channel === 'kivra' || channel === 'billo') return { provider: channel }
  return null
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
    const saved = await step(
      fetchImpl,
      `/api/invoices/${encodeURIComponent(input.invoiceId)}`,
      jsonInit('PATCH', input.payload),
    )
    if (!saved.ok) {
      return { ok: false, stage: 'persist', invoiceId: null, status: saved.status, error: saved.error }
    }
    invoiceId = input.invoiceId
    invoiceNumber = input.invoiceNumber ?? null
    if (input.documentType === 'invoice' && !invoiceNumber) {
      const finalized = await step(fetchImpl, `/api/invoices/${encodeURIComponent(invoiceId)}/finalize`, {
        method: 'POST',
      })
      if (!finalized.ok) {
        return { ok: false, stage: 'finalize', invoiceId, status: finalized.status, error: finalized.error }
      }
      const data = finalized.json?.data as { invoice_number?: string | null } | undefined
      invoiceNumber = data?.invoice_number ?? null
    }
  } else {
    const created = await step(fetchImpl, '/api/invoices', jsonInit('POST', input.payload))
    if (!created.ok) {
      return { ok: false, stage: 'persist', invoiceId: null, status: created.status, error: created.error }
    }
    const data = created.json?.data as { id?: string; invoice_number?: string | null } | undefined
    if (!data?.id) {
      return { ok: false, stage: 'persist', invoiceId: null, status: created.status, error: created.json }
    }
    invoiceId = data.id
    invoiceNumber = data.invoice_number ?? null
  }

  if (input.paidAtIssue) return issuePaid(fetchImpl, input, invoiceId, invoiceNumber, input.paidAtIssue)

  // 2. Attach. Only what this send carries: a mark-sent or a mailbox send
  // would fix the set without sending it to anyone.
  const carriesAttachments = input.channel === 'email' || input.channel === 'peppol'
  const attachmentIds = carriesAttachments ? input.attachmentDocumentIds ?? [] : []
  if (attachmentIds.length > 0) {
    const attached = await step(
      fetchImpl,
      `/api/invoices/${encodeURIComponent(invoiceId)}/attachments`,
      jsonInit('POST', { document_ids: attachmentIds }),
    )
    if (!attached.ok) {
      return { ok: false, stage: 'attach', invoiceId, status: attached.status, error: attached.error }
    }
  }

  // 3. Send.
  const route = SEND_ROUTES[input.channel]
  const body = buildSendStepBody(input.channel, input.email)
  const sent = await step(
    fetchImpl,
    `/api/invoices/${encodeURIComponent(invoiceId)}/${route}`,
    body ? jsonInit('POST', body) : { method: 'POST' },
  )
  if (!sent.ok) {
    return { ok: false, stage: 'send', invoiceId, status: sent.status, error: sent.error }
  }
  return {
    ok: true,
    invoiceId,
    invoiceNumber,
    partial: sent.json?.partial === true || peppolIssuancePartial(sent.json),
    message: typeof sent.json?.message === 'string' ? sent.json.message : null,
  }
}

/**
 * The Peppol send answers a follow-up failure after the verifikat (PDF
 * archive, periodisering, delivery history) inside its issuance
 * (data.issuance.partial_failures), not as the top-level partial the email
 * and mark-sent routes use.
 */
function peppolIssuancePartial(json: Record<string, unknown> | null): boolean {
  const data = json?.data as { issuance?: { partial_failures?: unknown } | null } | undefined
  const failures = data?.issuance?.partial_failures
  return Array.isArray(failures) && failures.length > 0
}

/** Steps 3 and 4 of a kontantfaktura: issue it paid, then mail the receipt when the channel is email. */
async function issuePaid(
  fetchImpl: FetchLike,
  input: SendSequenceInput,
  invoiceId: string,
  invoiceNumber: string | null,
  paidAtIssue: { account_number: string },
): Promise<SendSequenceResult> {
  const issued = await step(
    fetchImpl,
    `/api/invoices/${encodeURIComponent(invoiceId)}/mark-sent`,
    jsonInit('POST', { paid_at_issue: { account_number: paidAtIssue.account_number } }),
  )
  if (!issued.ok) {
    return { ok: false, stage: 'send', invoiceId, status: issued.status, error: issued.error }
  }
  const partial = issued.json?.partial === true
  if (input.channel !== 'email') {
    return { ok: true, invoiceId, invoiceNumber, partial, message: null }
  }
  const receipt = await step(
    fetchImpl,
    `/api/invoices/${encodeURIComponent(invoiceId)}/send-payment-confirmation`,
    { method: 'POST' },
  )
  return { ok: true, invoiceId, invoiceNumber, partial, message: null, receiptFailed: !receipt.ok }
}
