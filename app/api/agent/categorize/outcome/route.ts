import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { guardSandbox } from '@/lib/sandbox/guard'

/**
 * POST /api/agent/categorize/outcome: log one calibration sample.
 *
 * Called (fire-and-forget) after a user books an AI proposal: it records the
 * confidence the model reported and whether the proposed account was the one
 * actually booked. That corpus is what lib/agent/categorize/calibration.ts
 * later fits an isotonic calibrator on, so "säker" can be made to mean ~right.
 *
 * Telemetry only: it never posts anything and is gated on auth + membership.
 * Sandbox bookings run on seed data, so they are silently skipped (a 204) to
 * keep the corpus clean.
 */

const Schema = z.object({
  company_id: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  proposed_account: z.string().max(20).nullable().optional(),
  booked_account: z.string().min(1).max(20),
  agreement: z.number().min(0).max(1).nullable().optional(),
  model_confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  source: z.string().max(40).nullable().optional(),
  amount: z.number().nullable().optional(),
})

const noContent = () => new Response(null, { status: 204 })

export async function POST(request: Request): Promise<Response> {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = Schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const companyId = parsed.data.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return noContent()

  const { data: membership } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Sandbox bookings are seed data: don't pollute the calibration corpus.
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return noContent()

  const proposed = parsed.data.proposed_account ?? null

  // Best-effort: a failed telemetry insert must never surface to the user.
  try {
    await supabase.from('categorize_calibration_samples').insert({
      company_id: companyId,
      confidence: parsed.data.confidence,
      agreement: parsed.data.agreement ?? null,
      model_confidence: parsed.data.model_confidence ?? null,
      source: parsed.data.source ?? null,
      proposed_account: proposed,
      booked_account: parsed.data.booked_account,
      was_correct: proposed !== null && proposed === parsed.data.booked_account,
      amount: parsed.data.amount ?? null,
    })
  } catch {
    // swallow
  }

  return noContent()
}
