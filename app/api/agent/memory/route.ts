import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

// GET /api/agent/memory
//
// Lists memory entries for the active company, ordered by pin > relevance >
// recency. Powers /settings/agent-memory (transparency UI per plan §11).
//
// Query params:
//   include_dismissed: 'true' includes is_active=false rows (audit view).
//   kind:              filter by kind.
//   limit:             1..200, default 200 (matches the storage cap).
//
// POST /api/agent/memory
//
// Inserts a memory entry for the company. Used by Phase B's free-text seed
// memory field ("Lägg till om ditt företag (valfritt)") to capture
// foundational facts as `kind=fact`, `source=user_taught` with an elevated
// relevance score so they land in the top-30 prompt block.
//
// Also usable from /settings/agent-memory ("Lägg till minne" affordance) and
// post-Phase 4 explicit "Kom ihåg det här" surfaces.

const KIND = ['fact', 'preference', 'pattern', 'correction'] as const
const SOURCE = ['composer', 'user_taught', 'agent_learned', 'derived'] as const

const BodySchema = z.object({
  company_id: z.string().uuid().optional(),
  content: z.string().min(2).max(2000),
  kind: z.enum(KIND).default('fact'),
  source: z.enum(SOURCE).default('user_taught'),
  source_ref: z.string().max(200).optional(),
  // Default 1.0 keeps user-taught entries above composer-derived (0.5) by
  // default; conversation-time captures can land anywhere in [0, 1].
  relevance_score: z.number().min(0).max(1).default(1.0),
})

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  const url = new URL(request.url)
  const includeDismissed = url.searchParams.get('include_dismissed') === 'true'
  const kindParam = url.searchParams.get('kind')
  const kind = KIND.includes(kindParam as (typeof KIND)[number])
    ? (kindParam as (typeof KIND)[number])
    : null
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 200)

  let query = supabase
    .from('agent_memory')
    .select(
      'id, kind, content, source, source_ref, relevance_score, is_pinned, is_active, last_accessed_at, created_at, updated_at',
    )
    .eq('company_id', companyId)

  if (!includeDismissed) query = query.eq('is_active', true)
  if (kind) query = query.eq('kind', kind)

  query = query
    .order('is_active', { ascending: false })
    .order('is_pinned', { ascending: false })
    .order('relevance_score', { ascending: false })
    .order('last_accessed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  // requireWritePermission above checks the *active* company's role; if the
  // caller passes a different company_id in the body, re-check membership +
  // non-viewer role for THAT company specifically.
  const { data: bodyMembership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!bodyMembership || bodyMembership.role === 'viewer') {
    return NextResponse.json(
      { error: 'Du har endast läsbehörighet i detta företag.' },
      { status: 403 },
    )
  }

  const { data, error } = await supabase
    .from('agent_memory')
    .insert({
      company_id: companyId,
      kind: body.kind,
      content: body.content,
      source: body.source,
      source_ref: body.source_ref ?? null,
      relevance_score: body.relevance_score,
      is_active: true,
      created_by_user_id: user.id,
    })
    .select(
      'id, kind, content, source, source_ref, relevance_score, is_pinned, is_active, last_accessed_at, created_at, updated_at',
    )
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}
