import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

// The GET scope below builds a PostgREST .or() filter by string interpolation.
// Guard every interpolated id against a strict UUID shape so a tainted value
// can never inject filter syntax. Both ids are server-derived (companyId from
// membership, teamId from a DB column), so this is defense-in-depth.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BookingTemplateLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

const CreateBookingTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: z.enum([
    'eu_trade', 'tax_account', 'private_transfer',
    'salary', 'representation', 'year_end',
    'vat', 'financial', 'other',
  ]).default('other'),
  entity_type: z.enum(['all', 'enskild_firma', 'aktiebolag']).default('all'),
  lines: z.array(BookingTemplateLineSchema).min(2),
  team_id: z.string().uuid().optional(),
})

/**
 * GET /api/settings/booking-templates
 * Returns all templates visible to the current user:
 * system + company + team templates.
 *
 * Ordering: most recently used (per current company) first, then by category
 * and name for never-used templates. Usage is tracked in
 * booking_template_usage via POST /[id]/touch.
 */
export const GET = withRouteContext(
  'booking_template.list',
  async (_request, ctx) => {
    const { supabase, companyId } = ctx

    // Resolve the team this company belongs to (if any) so team-shared
    // templates stay visible while this company is selected.
    const { data: company } = await supabase
      .from('companies')
      .select('team_id')
      .eq('id', companyId)
      .maybeSingle()
    const teamId = company?.team_id ?? null

    // The wrapper only ever resolves a real membership UUID, but assert the
    // shape before interpolating it into the .or() filter.
    if (!UUID_RE.test(companyId)) {
      return NextResponse.json({ error: 'Invalid company context' }, { status: 400 })
    }

    // Scope to the SELECTED company: system + this company + this company's team.
    // RLS (btl_select) is membership-wide: it returns templates from *every*
    // company the user belongs to: so the active-company narrowing must happen
    // here in the API layer (mirrors counterparty-templates). Without this, a
    // user who owns several companies sees all of their templates merged.
    // Only interpolate a team id that passes the strict UUID guard.
    const scope = [
      'is_system.eq.true',
      `company_id.eq.${companyId}`,
      ...(teamId && UUID_RE.test(teamId) ? [`team_id.eq.${teamId}`] : []),
    ].join(',')

    const [templatesRes, usageRes] = await Promise.all([
      supabase
        .from('booking_template_library')
        .select('*')
        .eq('is_active', true)
        .or(scope)
        .order('category')
        .order('name'),
      supabase
        .from('booking_template_usage')
        .select('template_id, last_used_at')
        .eq('company_id', companyId),
    ])

    if (templatesRes.error) {
      return NextResponse.json({ error: templatesRes.error.message }, { status: 500 })
    }
    // usage lookup failing is non-fatal: we just fall back to default ordering
    const usageByTemplate = new Map<string, string>()
    if (!usageRes.error && usageRes.data) {
      for (const row of usageRes.data) {
        usageByTemplate.set(row.template_id, row.last_used_at)
      }
    }

    const templates = templatesRes.data ?? []
    const decorated = templates.map((t) => ({
      ...t,
      last_used_at: usageByTemplate.get(t.id) ?? null,
    }))

    // Stable-sort: templates with last_used_at come first (most-recent first).
    // Templates without usage keep their category/name order from the query.
    // ISO 8601 timestamps are fixed-width ASCII: plain relational comparison
    // is correct and avoids any locale-dependent behaviour from localeCompare.
    decorated.sort((a, b) => {
      const aUsed = a.last_used_at
      const bUsed = b.last_used_at
      if (aUsed && bUsed) {
        if (bUsed > aUsed) return -1
        if (bUsed < aUsed) return 1
        return 0
      }
      if (aUsed) return -1
      if (bUsed) return 1
      return 0
    })

    return NextResponse.json({ data: decorated })
  },
)

/**
 * POST /api/settings/booking-templates
 * Create a company-scoped or team-scoped template.
 */
export const POST = withRouteContext(
  'booking_template.create',
  async (request, ctx) => {
    const { supabase, user } = ctx

    const result = await validateBody(request, CreateBookingTemplateSchema)
    if (!result.success) return result.response

    const body = result.data
    const companyId = body.team_id ? null : ctx.companyId

    const { data, error } = await supabase
      .from('booking_template_library')
      .insert({
        company_id: companyId,
        team_id: body.team_id ?? null,
        created_by: user.id,
        name: body.name,
        description: body.description,
        category: body.category,
        entity_type: body.entity_type,
        lines: body.lines,
        is_system: false,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data }, { status: 201 })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/settings/booking-templates
 * Soft-delete a template by id (company or team scope only, never system).
 */
export const DELETE = withRouteContext(
  'booking_template.delete',
  async (request, ctx) => {
    const { supabase } = ctx

    let id: string | undefined
    try {
      const body = await request.json()
      id = body?.id
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    // RLS prevents deleting system templates (btl_delete policy checks NOT is_system)
    const { error } = await supabase
      .from('booking_template_library')
      .update({ is_active: false })
      .eq('id', id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
