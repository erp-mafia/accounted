/**
 * POST /api/v1/companies/{companyId}/documents/{id}/link
 *
 * Link an already-uploaded document to a journal entry (and optionally a
 * specific line). Wraps lib/core/documents/document-service.linkToJournalEntry.
 *
 * Body: `{ journal_entry_id: UUID, journal_entry_line_id?: UUID }`.
 *
 * The link is REVERSIBLE — set journal_entry_id back via the dashboard if
 * needed (no unlink endpoint in v1 yet to keep the WORM contract tight).
 * Once the journal entry it points at is committed (status='posted'), the
 * document row is effectively immutable per BFL 7 kap.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable: confirms the JE
 * and document both exist + belong to the company without persisting.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

const Body = z
  .object({
    journal_entry_id: z.string().uuid(),
    journal_entry_line_id: z.string().uuid().optional(),
  })
  .strict()

const DocumentLinkedResponse = z.object({
  id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  journal_entry_line_id: z.string().uuid().nullable(),
  file_name: z.string(),
})

registerEndpoint({
  operation: 'documents.link',
  method: 'POST',
  path: '/api/v1/companies/:companyId/documents/:id/link',
  summary: 'Link a document to a journal entry.',
  description:
    'Sets journal_entry_id (and optionally journal_entry_line_id) on an existing document. Use this after /documents upload when the link target was unknown at upload time, or to re-link a stray document. Once the target JE is posted, the document row is effectively immutable per BFL 7 kap retention.',
  useWhen:
    'A document was uploaded without a journal_entry_id (e.g. bulk import) and you now want to attach it to a posted verifikation.',
  doNotUseFor:
    'Unlinking — no v1 unlink endpoint. The dashboard exposes a manual override; v1 keeps the WORM contract by refusing to revert posted-JE links.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Both the document and the journal_entry_id must belong to the caller\'s company. NOT_FOUND on mismatch (enumeration hardening).',
    'Re-linking an already-linked document overwrites the previous journal_entry_id — confirm the old target is what you intend to break.',
  ],
  example: {
    request: { journal_entry_id: 'a8f1…' },
    response: {
      data: {
        id: '0e9c…',
        journal_entry_id: 'a8f1…',
        journal_entry_line_id: null,
        file_name: 'kvitto-2026-05-12.pdf',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: Body },
  response: { success: DocumentLinkedResponse },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'documents.link',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'document id must be a UUID.' },
      })
    }
    const documentId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = Body.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const body = parsed.data

    // Ownership pre-check: document AND target JE must both belong to the
    // caller's company before the link write. Otherwise the row could
    // persist with a cross-tenant journal_entry_id pointer. Capture
    // `.error` on both — a DB fault must not silently masquerade as a
    // NOT_FOUND (round-1 finding).
    const [docRes, jeRes] = await Promise.all([
      ctx.supabase
        .from('document_attachments')
        .select('id, file_name, journal_entry_id')
        .eq('id', documentId)
        .eq('company_id', ctx.companyId!)
        .maybeSingle(),
      ctx.supabase
        .from('journal_entries')
        .select('id')
        .eq('id', body.journal_entry_id)
        .eq('company_id', ctx.companyId!)
        .maybeSingle(),
    ])

    if (docRes.error) {
      ctx.log.error('documents.link doc pre-check DB error', docRes.error as Error, { documentId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId, details: { step: 'doc_ownership_check' },
      })
    }
    if (jeRes.error) {
      ctx.log.error('documents.link JE pre-check DB error', jeRes.error as Error, { journalEntryId: body.journal_entry_id })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId, details: { step: 'je_ownership_check' },
      })
    }

    const doc = docRes.data as { id: string; file_name: string; journal_entry_id: string | null } | null
    const je = jeRes.data

    if (!doc) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'document' },
      })
    }
    if (!je) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'journal_entry', field: 'journal_entry_id' },
      })
    }

    // WORM guard: if this document is ALREADY linked to a posted JE, refuse
    // the overwrite. BFL 5 kap 5 § + 7 kap require posted räkenskaps-
    // information (incl. the link to underlying documents) to remain
    // immutable. The pre-check confirms the new target — without this
    // additional check the caller could silently break the link to an
    // already-posted verifikation.
    if (doc.journal_entry_id && doc.journal_entry_id !== body.journal_entry_id) {
      const { data: existingJe } = await ctx.supabase
        .from('journal_entries')
        .select('id, status')
        .eq('id', doc.journal_entry_id)
        .eq('company_id', ctx.companyId!)
        .maybeSingle()
      if (existingJe && (existingJe as { status: string }).status === 'posted') {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: {
            reason: 'document_already_linked_to_posted_entry',
            current_journal_entry_id: doc.journal_entry_id,
            remediation:
              'Documents linked to posted verifikationer cannot be re-linked (BFL 5 kap 5 §). Upload a new document and link the new one to the new target.',
          },
        })
      }
    }

    // journal_entry_line_id ownership: must belong to the target JE.
    // Skipped above (only document + JE) because the line ownership is
    // transitively bound through journal_entry_id (which we just verified).
    if (body.journal_entry_line_id) {
      const { data: lineRow, error: lineErr } = await ctx.supabase
        .from('journal_entry_lines')
        .select('id')
        .eq('id', body.journal_entry_line_id)
        .eq('journal_entry_id', body.journal_entry_id)
        .maybeSingle()
      if (lineErr) {
        ctx.log.error('documents.link line pre-check DB error', lineErr as Error)
        return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
          requestId: ctx.requestId, details: { step: 'je_line_ownership_check' },
        })
      }
      if (!lineRow) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'journal_entry_line', field: 'journal_entry_line_id' },
        })
      }
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: documentId,
          journal_entry_id: body.journal_entry_id,
          journal_entry_line_id: body.journal_entry_line_id ?? null,
          file_name: doc.file_name,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const updated = await linkToJournalEntry(
        ctx.supabase,
        ctx.companyId!,
        documentId,
        body.journal_entry_id,
        body.journal_entry_line_id,
      )
      return ok(
        {
          id: updated.id,
          journal_entry_id: updated.journal_entry_id!,
          journal_entry_line_id: updated.journal_entry_line_id,
          file_name: updated.file_name,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('documents.link failed', err as Error, { documentId, journalEntryId: body.journal_entry_id })
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
