/**
 * The door of the token routes under /api/attest/[token]: the attest mail's
 * link (attest-links.ts) is the authentication, so every route resolves the
 * token first and then runs the SAME attest service as the dashboard
 * (attest-service.ts), as the attester the link was minted for, for the
 * company the link names.
 *
 * The posture of withInviteToken (lib/bank-feed/invite-route.ts): no
 * session, no supabase.auth; the service-role client reads the row; a
 * per-token budget bounds a leaked link; the clear token is never logged
 * (the logger gets the link id). Every way a token fails (malformed,
 * unknown, expired, used) answers the same 404, and so does a link whose
 * attester is no longer a member who may write, or whose company is archived.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { contentDisposition } from '@/lib/api/content-disposition'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'
import { readLiveMembership } from '@/lib/company/company-access'
import { OPAQUE_DOCUMENT_CSP, inlineSafeMimeType } from '@/lib/core/documents/storage-proxy'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger, type Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { isValidAttestTokenFormat, resolveAttestLink, type AttestLinkRow } from './attest-links'
import { getSupplierInvoiceAttestState, loadAttestPeople } from './attest-service'

// 30 requests per token per 10 minutes: one page, the PDF, one decision and
// a few reloads. Process-local, like the signatory link's limiter.
const limiter = createTokenRateLimiter({ max: 30, windowMs: 10 * 60_000 })

/**
 * The link's attester still writes in a company that is still live: what opens
 * the link, page and routes alike, for the per-invoice link and the batched
 * mail's list link (attest-batch-route.ts) both.
 */
export async function attesterCanStillDecide(
  service: SupabaseClient,
  link: Pick<AttestLinkRow, 'attester_user_id' | 'company_id'>,
): Promise<boolean> {
  const membership = await readLiveMembership(service, link.attester_user_id, link.company_id)
  return membership !== null && isBookkeepingWriterRole(membership.role)
}

export interface AttestLinkRouteContext {
  link: AttestLinkRow
  service: SupabaseClient
  /** The operation context the attest service takes: the company of the link, acting as its attester. */
  op: OperationContext
  log: Logger
  requestId: string
}

type Params<P> = { params: Promise<P> }

export type AttestLinkRouteHandler<P> = (request: Request, ctx: AttestLinkRouteContext, params: P) => Promise<Response>

/** Wrap a token route; `operation` names it in the logs ('attest_link.decide'). */
export function withAttestLinkToken<P extends { token: string }>(operation: string, handler: AttestLinkRouteHandler<P>) {
  return async (request: Request, { params }: Params<P>): Promise<Response> => {
    const requestId = randomUUID()
    const log = createLogger('attest-link', { requestId, operation })
    const resolvedParams = await params
    const token = resolvedParams.token
    if (!isValidAttestTokenFormat(token)) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'malformed attest token' })
    if (!limiter.allow(token)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'attest token over its budget' })

    const service = createServiceClientNoCookies()
    try {
      const resolved = await resolveAttestLink(service, token)
      if (!resolved.ok) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `attest link ${resolved.reason}` })
      const { link } = resolved
      const linkLog = log.child({ companyId: link.company_id, attestLinkId: link.id })
      if (!(await attesterCanStillDecide(service, link))) {
        return errorResponseFromCode('NOT_FOUND', linkLog, { requestId, reason: 'attest link of someone no longer a writing member of a live company' })
      }
      return await handler(
        request,
        {
          link,
          service,
          op: { supabase: service, companyId: link.company_id, userId: link.attester_user_id, log: linkLog },
          log: linkLog,
          requestId,
        },
        resolvedParams,
      )
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  }
}

export interface AttestLinkPageData {
  company_name: string
  attester_name: string | null
  invoice: {
    supplier_name: string | null
    supplier_invoice_number: string | null
    arrival_number: number
    invoice_date: string
    due_date: string
    total: number
    currency: string
    has_document: boolean
  }
  registered_by: string | null
  /** open: the decision is the attester's to make; attested: already done; closed: no longer waiting for attest. */
  state: 'open' | 'attested' | 'closed'
  may_approve: boolean
  may_reject: boolean
  /** Why the attester may not decide, when they may not (attest-service reasons). */
  reason: string | null
  approved_names: string[]
  remaining_names: string[]
  mode: 'any' | 'all'
  expires_at: string
}

/** What the page under /attest/<token> shows: the invoice, who registered it, where the attest stands. */
export async function describeAttestLink(service: SupabaseClient, link: AttestLinkRow, log: Logger): Promise<AttestLinkPageData> {
  const [{ data: invoiceRow, error: invoiceError }, { data: companyRow }] = await Promise.all([
    service
      .from('supplier_invoices')
      .select('id, user_id, supplier_invoice_number, arrival_number, invoice_date, due_date, total, currency, document_id, status, approved_at, supplier:suppliers(name)')
      .eq('company_id', link.company_id)
      .eq('id', link.supplier_invoice_id)
      .maybeSingle(),
    service.from('companies').select('name').eq('id', link.company_id).maybeSingle(),
  ])
  if (invoiceError) throw invoiceError
  const invoice = invoiceRow as unknown as {
    user_id: string
    supplier_invoice_number: string | null
    arrival_number: number
    invoice_date: string
    due_date: string
    total: number
    currency: string
    document_id: string | null
    status: string
    approved_at: string | null
    supplier: { name: string | null } | null
  }
  const state = await getSupplierInvoiceAttestState(
    { supabase: service, companyId: link.company_id, userId: link.attester_user_id, log },
    link.supplier_invoice_id,
    { writer: service },
  )
  if (!state.ok || state.dryRun) throw new Error('Attest state not readable for the link')
  const people = await loadAttestPeople(service, [invoice.user_id, link.attester_user_id])
  const nameOf = (p: { name: string | null; email: string | null }) => p.name ?? p.email ?? null
  const attest = state.data
  return {
    company_name: (companyRow as { name: string | null } | null)?.name?.trim() || 'Företaget',
    attester_name: nameOf(people.get(link.attester_user_id) ?? { name: null, email: null }),
    invoice: {
      supplier_name: invoice.supplier?.name ?? null,
      supplier_invoice_number: invoice.supplier_invoice_number,
      arrival_number: invoice.arrival_number,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date,
      total: Number(invoice.total),
      currency: invoice.currency,
      has_document: !!invoice.document_id,
    },
    registered_by: nameOf(people.get(invoice.user_id) ?? { name: null, email: null }),
    state: invoice.approved_at ? 'attested' : attest.viewer.reason === 'not_pending' ? 'closed' : 'open',
    may_approve: attest.viewer.may_approve,
    may_reject: attest.viewer.may_reject,
    reason: attest.viewer.reason,
    approved_names: attest.approved.map((p) => nameOf(p)).filter((n): n is string => !!n),
    remaining_names: attest.remaining.map((p) => nameOf(p)).filter((n): n is string => !!n),
    mode: attest.policy.mode,
    expires_at: link.expires_at,
  }
}

export function attestLinkJson(data: unknown): NextResponse {
  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
}

const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * The supplier's own invoice document, for the attest pages a mail's link
 * opens without a login: only the document of the invoice the caller's link
 * covers; streamed inline the way /api/documents/:id/inline does, under the
 * opaque CSP for anything that is not a PDF or a picture.
 */
export async function attestInvoiceDocumentResponse(
  service: SupabaseClient,
  companyId: string,
  invoiceId: string,
  log: Logger,
  requestId: string,
): Promise<Response> {
  const { data: invoice } = await service.from('supplier_invoices').select('document_id').eq('company_id', companyId).eq('id', invoiceId).maybeSingle()
  const documentId = (invoice as { document_id: string | null } | null)?.document_id
  if (!documentId) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link invoice without a document' })
  const { data: doc } = await service
    .from('document_attachments')
    .select('id, file_name, mime_type, storage_path')
    .eq('company_id', companyId)
    .eq('id', documentId)
    .maybeSingle()
  const row = doc as { file_name: string; mime_type: string | null; storage_path: string } | null
  if (!row) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link document missing' })
  const { data: blob, error } = await service.storage.from('documents').download(row.storage_path)
  if (error || !blob) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'attest link document not downloadable' })
  const ext = row.file_name.toLowerCase().split('.').pop() ?? ''
  const contentType =
    row.mime_type && row.mime_type !== 'application/octet-stream' ? row.mime_type : EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream'
  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition('inline', row.file_name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(inlineSafeMimeType(contentType) ? {} : { 'Content-Security-Policy': OPAQUE_DOCUMENT_CSP }),
    },
  })
}
