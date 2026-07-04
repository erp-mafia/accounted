import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWritePermission } from '@/lib/auth/require-write'

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const { id } = await params

  let body: z.infer<typeof PatchSchema>
  try {
    body = PatchSchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

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
  if (!existing) return NextResponse.json({ error: 'Memory not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', existing.company_id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Memory not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('agent_memory')
    .update(update)
    .eq('id', id)
    .eq('company_id', existing.company_id)
    .select(
      'id, kind, content, source, source_ref, relevance_score, is_pinned, is_active, last_accessed_at, created_at, updated_at',
    )
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Memory not found' }, { status: 404 })

  return NextResponse.json({ data })
}
