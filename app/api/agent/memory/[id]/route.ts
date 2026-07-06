import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

// PATCH /api/agent/memory/[id]
//
// Mutate a single memory entry. Powers the list/edit/pin/dismiss affordances
// on /settings/agent-memory (plan §11).
//
//   content: edit the durable text (kind never changes; that would
//                muddle the audit lineage). Append-only is preserved by
//                superseded_by chains when an upstream caller wants it; the
//                transparency UI is allowed to overwrite in place because
//                the row's `updated_at` already documents the edit.
//   is_pinned: boost into the top-N prompt block regardless of score.
//   is_active: false = dismiss (removes from ranking pool); true = restore.
//
// RLS scopes to user_company_ids(); we ALSO re-verify membership for the
// row's company_id as defense in depth before mutating.

const PatchSchema = z
  .object({
    content: z.string().min(2).max(2000).optional(),
    is_pinned: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (v) => v.content !== undefined || v.is_pinned !== undefined || v.is_active !== undefined,
    { message: 'Nothing to update' },
  )

const notFound = () =>
  NextResponse.json(
    {
      error: {
        code: 'MEMORY_NOT_FOUND',
        message: 'Minnet hittades inte.',
        message_en: 'Memory not found.',
      },
    },
    { status: 404 },
  )

export const PATCH = withRouteContext(
  'agent.memory.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, user, log } = ctx

    const validation = await validateBody(request, PatchSchema, {
      log,
      operation: 'agent.memory.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const update: Record<string, unknown> = {}
    if (body.content !== undefined) update.content = body.content
    if (body.is_pinned !== undefined) update.is_pinned = body.is_pinned
    if (body.is_active !== undefined) update.is_active = body.is_active

    // Look up the row's company_id and re-check membership before mutating.
    const { data: existing } = await supabase
      .from('agent_memory')
      .select('company_id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return notFound()

    const { data: membership } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', existing.company_id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return notFound()

    const { data, error } = await supabase
      .from('agent_memory')
      .update(update)
      .eq('id', id)
      .eq('company_id', existing.company_id)
      .select(
        'id, kind, content, source, source_ref, relevance_score, is_pinned, is_active, last_accessed_at, created_at, updated_at',
      )
      .maybeSingle()
    if (error) throw error
    if (!data) return notFound()

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
