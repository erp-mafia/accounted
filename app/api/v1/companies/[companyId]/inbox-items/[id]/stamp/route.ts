/**
 * POST /api/v1/companies/{companyId}/inbox-items/{id}/stamp
 *
 * Mark an invoice inbox item as consumed by stamping it with the journal entry
 * that was created for it. Sets `created_journal_entry_id` on the
 * invoice_inbox_items row, which removes the item from the active inbox todo.
 *
 * Idempotent: calling with the same journal_entry_id when the item is already
 * stamped returns 200. Calling with a different journal_entry_id when the item
 * is already stamped returns CONFLICT.
 *
 * Use this when the document was linked via POST .../documents/{id}/link
 * WITHOUT an inbox_item_id (e.g. the v1 link call was made before this
 * endpoint existed). For new flows, pass inbox_item_id directly to the
 * link endpoint to do both in one call.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const Body = z
  .object({
    journal_entry_id: z.string().uuid(),
  })
  .strict()

const InboxItemStampedResponse = z.object({
  id: z.string().uuid(),
  created_journal_entry_id: z.string().uuid(),
})

registerEndpoint({
  operation: 'inbox-items.stamp',
  method: 'POST',
  path: '/api/v1/companies/:companyId/inbox-items/:id/stamp',
  summary: 'Mark an inbox item as consumed by a journal entry.',
  description:
    'Sets created_journal_entry_id on an invoice_inbox_items row so the item drops out of the active inbox todo list. Use when the document was linked to a JE via a separate call and you need to close the inbox item independently.',
  useWhen:
    'An inbox document has already been attached to a verifikation (via documents link) but the inbox item itself was not stamped at link time: e.g. when using the v1 link endpoint without inbox_item_id.',
  doNotUseFor:
    'Creating a new journal entry from an inbox item: use the invoice-inbox extension book-direct route for that.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The inbox item and journal_entry_id must both belong to the caller\'s company.',
    'Stamping with a different journal_entry_id than the one already set returns CONFLICT: the item is already resolved.',
  ],
  example: {
    request: { journal_entry_id: 'dcccb3c5-b44a-4536-82fa-f0b9bb77f900' },
    response: {
      data: {
        id: '4d2fcdbb-13b3-4ff3-911f-a4cc82f1f6db',
        created_journal_entry_id: 'dcccb3c5-b44a-4536-82fa-f0b9bb77f900',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: Body },
  response: { success: dataEnvelope(InboxItemStampedResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'inbox-items.stamp',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'inbox item id must be a UUID.' },
      })
    }
    const itemId = idParse.data

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

    const [itemRes, jeRes] = await Promise.all([
      ctx.supabase
        .from('invoice_inbox_items')
        .select('id, created_journal_entry_id')
        .eq('id', itemId)
        .eq('company_id', ctx.companyId!)
        .maybeSingle(),
      ctx.supabase
        .from('journal_entries')
        .select('id')
        .eq('id', body.journal_entry_id)
        .eq('company_id', ctx.companyId!)
        .maybeSingle(),
    ])

    if (itemRes.error) {
      ctx.log.error('inbox-items.stamp item pre-check DB error', itemRes.error as Error, { itemId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'item_ownership_check' },
      })
    }
    if (jeRes.error) {
      ctx.log.error('inbox-items.stamp JE pre-check DB error', jeRes.error as Error, {
        journalEntryId: body.journal_entry_id,
      })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'je_ownership_check' },
      })
    }

    if (!itemRes.data) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'inbox_item' },
      })
    }
    if (!jeRes.data) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'journal_entry', field: 'journal_entry_id' },
      })
    }

    const item = itemRes.data as { id: string; created_journal_entry_id: string | null }

    // Idempotent: already stamped to the same JE: return success.
    if (item.created_journal_entry_id === body.journal_entry_id) {
      return ok(
        { id: item.id, created_journal_entry_id: item.created_journal_entry_id! },
        { requestId: ctx.requestId },
      )
    }

    // Conflict: already stamped to a different JE.
    if (item.created_journal_entry_id && item.created_journal_entry_id !== body.journal_entry_id) {
      return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'inbox_item_already_stamped',
          current_journal_entry_id: item.created_journal_entry_id,
        },
      })
    }

    const { error: updateErr } = await ctx.supabase
      .from('invoice_inbox_items')
      .update({ created_journal_entry_id: body.journal_entry_id })
      .eq('id', itemId)
      .eq('company_id', ctx.companyId!)

    if (updateErr) {
      ctx.log.error('inbox-items.stamp update failed', updateErr as Error, {
        itemId,
        journalEntryId: body.journal_entry_id,
      })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'stamp_update' },
      })
    }

    return ok(
      { id: itemId, created_journal_entry_id: body.journal_entry_id },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
