import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { StrikeDocumentLinkSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { strikeDocumentLink } from '@/lib/documents/strike-link'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'

/**
 * POST /api/documents/[id]/strike: the document is on the wrong verifikat.
 *
 * Body: { journal_entry_id, reason }. The verifikat named gets a
 * byte-identical copy and the link on the verifikat that holds the document
 * is struck with the reason: nothing moves and nothing is deleted
 * (lib/documents/strike-link.ts, enforce_document_link_strike). The person is
 * the session's user and the time the database's clock (BFL 5 kap 9 §).
 *
 * Answers { data: { document, copy } }: the struck row, and the copy the
 * right verifikat holds (reused when it already held these bytes).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'documents.strike',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ documentId: id })

    const parsed = StrikeDocumentLinkSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), reason: issue.message })),
        },
      })
    }

    try {
      const outcome = await strikeDocumentLink(supabase, companyId!, user.id, {
        document_id: id,
        journal_entry_id: parsed.data.journal_entry_id,
        reason: parsed.data.reason,
      })
      if (!outcome.ok) {
        if (outcome.code === 'NOT_FOUND') {
          return errorResponseFromCode(outcome.resource === 'document' ? 'DOC_NOT_FOUND' : 'DOC_LINK_ENTRY_NOT_FOUND', opLog, {
            requestId,
          })
        }
        return errorResponseFromCode(outcome.code, opLog, { requestId })
      }
      return NextResponse.json({ data: { document: outcome.document, copy: outcome.copy } })
    } catch (err) {
      opLog.error('document strike failed', err as Error, { journalEntryId: parsed.data.journal_entry_id })
      return errorResponseFromCode('DOC_STRIKE_FAILED', opLog, { requestId })
    }
  },
  { requireWrite: true, uuidParams: { id: 'DOC_NOT_FOUND' } },
)

/**
 * GET /api/documents/[id]/strike: the strike of the document's link, for the
 * verifikat page to state who struck it, when and why, and which verifikat
 * got the copy. { data: null } when the link is not struck.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'documents.strike.read',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const { data: doc, error } = await supabase
      .from('document_attachments')
      .select('id, link_struck_at, link_struck_by, link_struck_reason, link_struck_copy_id')
      .eq('id', id)
      .eq('company_id', companyId!)
      .maybeSingle()
    if (error) return errorResponse(error, log, { requestId })
    if (!doc) return errorResponseFromCode('DOC_NOT_FOUND', log, { requestId })
    const row = doc as {
      id: string
      link_struck_at: string | null
      link_struck_by: string | null
      link_struck_reason: string | null
      link_struck_copy_id: string | null
    }
    if (!row.link_struck_at || !row.link_struck_by) return NextResponse.json({ data: null })

    // `profiles` RLS is self-only, so the label is read through the service
    // client, for exactly the person this company's own row names (the
    // rättelse log's precedent). A name kept after the account was deleted
    // comes from rattelse_actor_names the same way.
    let byLabel: string | null = null
    try {
      const labels = await resolveUserLabelsFromProfiles(createServiceClient(), [row.link_struck_by], companyId!)
      byLabel = labels.get(row.link_struck_by) ?? null
    } catch (labelError) {
      // The label only names the person; the strike answers with their id either way.
      log.warn('strike actor label lookup failed', { documentId: id, reason: (labelError as Error).message })
    }

    let copy: {
      document_id: string
      journal_entry_id: string
      voucher_series: string | null
      voucher_number: number | null
    } | null = null
    if (row.link_struck_copy_id) {
      const { data: copyRow, error: copyError } = await supabase
        .from('document_attachments')
        .select('id, journal_entry_id')
        .eq('id', row.link_struck_copy_id)
        .eq('company_id', companyId!)
        .maybeSingle()
      if (copyError) return errorResponse(copyError, log, { requestId })
      const copyDoc = copyRow as { id: string; journal_entry_id: string | null } | null
      if (copyDoc?.journal_entry_id) {
        const { data: entry, error: entryError } = await supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number')
          .eq('id', copyDoc.journal_entry_id)
          .eq('company_id', companyId!)
          .maybeSingle()
        if (entryError) return errorResponse(entryError, log, { requestId })
        const voucher = entry as { voucher_series: string | null; voucher_number: number | null } | null
        copy = {
          document_id: copyDoc.id,
          journal_entry_id: copyDoc.journal_entry_id,
          voucher_series: voucher?.voucher_series ?? null,
          voucher_number: voucher?.voucher_number ?? null,
        }
      }
    }

    return NextResponse.json({
      data: {
        struck_at: row.link_struck_at,
        struck_by: row.link_struck_by,
        struck_by_label: byLabel,
        reason: row.link_struck_reason,
        copy,
      },
    })
  },
  { uuidParams: { id: 'DOC_NOT_FOUND' } },
)
