import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveCompanyId } from '@/lib/company/context'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { gatherComposerInputs, inputsToSourceSignals } from '@/lib/agent/composer/inputs'
import { selectAtoms } from '@/lib/agent/composer/atom-selection'
import { writeNarrative } from '@/lib/agent/composer/narrative'
import { fallbackAtomSelection, fallbackNarrative } from '@/lib/agent/composer/fallback'
import { filterRedundantQuestions } from '@/lib/agent/composer/atom-selection'
import { preWarmAtomCache } from '@/lib/agent/composer/prewarm'
import { OPUS_MODEL } from '@/lib/agent/composer/client'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'
import type { AtomSelection } from '@/lib/agent/composer/schemas'

const BodySchema = z.object({
  company_id: z.string().uuid().optional(),
})

// 10s: the user is on a wait-screen with visible progress, so we can afford
// the longer budget. The prior 5s clipped legitimate fetches (TIC fans out to
// ~13 Lens calls upstream) into the fallback bucket while still burning the
// in-flight upstream calls against quota. See actions.ts:182-189 for the
// May 2026 incident context.
const TIC_BUDGET_MS = 10_000
// Bedrock cold-starts can take 2-3s before the first token, plus the actual
// Opus selection call typically lands at 10-14s. 15s was too tight and put
// real Opus calls into the fallback bucket on the first turn of the day.
const SELECT_BUDGET_MS = 25_000
const NARRATIVE_BUDGET_MS = 8_000

// Per-step event shape streamed as NDJSON. Each line is one JSON object.
type Step = 'tic' | 'select' | 'narrative' | 'finalize' | 'prewarm'
type Status = 'in_progress' | 'success' | 'fallback' | 'skipped' | 'error'
type StreamEvent =
  | { step: Step; status: Status }
  | { step: 'select'; status: 'success' | 'fallback'; selection: AtomSelection }
  | { step: 'narrative'; status: 'success' | 'fallback'; narrative: string }
  | { step: 'finalize'; status: 'success'; profile: ProfilePayload }
  | { step: 'error'; status: 'error'; message: string }

interface ProfilePayload {
  company_id: string
  horizontal_atoms: string[]
  vertical_atoms: string[]
  modifier_atoms: string[]
  is_multi_vertical: boolean
  profile_summary: string
  verification_questions: string[]
  uncertainty_notes: string[]
  composer_model: string
  composed_at: string
}

// POST /api/agent/onboarding/stream
//
// Streams real-timed progress for the agent build sequence (plan §7 Phase A).
// Each step runs on its actual latency: no artificial delays. On timeout or
// failure, the step emits `fallback` and the pipeline continues with a
// deterministic default so the user always reaches Phase B.
//
// Response: application/x-ndjson, one JSON event per line.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Generous per-user rate limit: bounds reload-spam of the onboarding build
  // (each run fires 2 LLM calls). Fails open on infra error.
  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) {
    return NextResponse.json(agentRateLimitResponseBody(rate), {
      status: 429,
      headers: rate.retryAfterSec ? { 'Retry-After': String(rate.retryAfterSec) } : undefined,
    })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json().catch(() => ({})))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) {
    return NextResponse.json({ error: 'No active company' }, { status: 400 })
  }

  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this company' }, { status: 403 })
  }
  // The pipeline upserts agent_profiles — a mutation, so viewers are refused
  // (same rule as /api/agent/profile and /verify).
  if (membership.role === 'viewer') {
    return NextResponse.json(
      { error: 'Du har endast läsbehörighet i detta företag.' },
      { status: 403 },
    )
  }

  // No live composer run for sandbox companies: they ship with a pre-built
  // verified agent_profile so the chrome is visible without burning Bedrock.
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        } catch {
          // Stream was cancelled (user navigated away). Subsequent enqueues
          // would throw: we just stop emitting.
        }
      }

      try {
        // Step 1: TIC: read companies.tic_snapshot; if missing or stale,
        // live-fetch from the TIC extension (cookies forwarded from the
        // incoming request) and persist. Falls through gracefully when TIC is
        // disabled, the company has no org_number, or the request times out.
        send({ step: 'tic', status: 'in_progress' })
        const cookieHeader = request.headers.get('cookie') ?? ''
        // SSRF guard: derive origin from NEXT_PUBLIC_APP_URL (a required env
        // var per CLAUDE.md) instead of request.headers.host. On self-hosted
        // Docker the Host header can be attacker-controlled and would
        // otherwise let an attacker redirect the cookie-bearing TIC fetch to
        // a host they control.
        const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? ''
        const fallbackHost = request.headers.get('host') ?? 'localhost:3000'
        const fallbackProto =
          request.headers.get('x-forwarded-proto') ??
          (fallbackHost.startsWith('localhost') ? 'http' : 'https')
        const origin = appUrl || `${fallbackProto}://${fallbackHost}`
        const ticResult = await withTimeout(
          // upgradeV1: agent build is the consumer of the v2-only sections;
          // bounded to companies actively creating an agent, so the TIC
          // budget stays safe even when upgrading pre-v2 snapshots.
          // timeoutMs: lift the internal fetch signal to match the outer
          // budget: otherwise the 5s default fires first and we get the
          // pre-fix behavior even with the longer outer budget.
          ensureTicSnapshot({
            supabase,
            companyId,
            cookieHeader,
            origin,
            upgradeV1: true,
            timeoutMs: TIC_BUDGET_MS,
          }),
          TIC_BUDGET_MS,
        ).catch(() => ({ snapshot: null, source: 'fallback' as const }))
        send({
          step: 'tic',
          status: ticResult.snapshot ? 'success' : 'fallback',
        })

        // Gather inputs once: used by select + narrative + persistence.
        const inputs = await gatherComposerInputs(supabase, companyId)

        // Step 2: Opus atom selection with timeout + deterministic fallback.
        send({ step: 'select', status: 'in_progress' })
        let selection: AtomSelection
        try {
          selection = await withTimeout(selectAtoms(inputs), SELECT_BUDGET_MS)
          send({ step: 'select', status: 'success', selection })
        } catch {
          selection = fallbackAtomSelection(inputs)
          send({ step: 'select', status: 'fallback', selection })
        }

        // Filter verification questions deterministically regardless of which
        // path produced the selection. fallbackAtomSelection generates a
        // generic template that doesn't know about KÄNDA FAKTA; the Opus
        // path is also re-filtered in case the model strayed. Cheap belt-
        // and-braces: same function used for both.
        selection.verification_questions = filterRedundantQuestions(
          selection.verification_questions,
          inputs,
          selection.modifier_atoms,
        )

        // Step 3: Sonnet narrative with timeout + plain fallback.
        send({ step: 'narrative', status: 'in_progress' })
        let narrative: string
        try {
          narrative = await withTimeout(writeNarrative(inputs, selection), NARRATIVE_BUDGET_MS)
          send({ step: 'narrative', status: 'success', narrative })
        } catch {
          narrative = fallbackNarrative(inputs)
          send({ step: 'narrative', status: 'fallback', narrative })
        }

        // Step 4: Persist the profile so Phase B has a row to edit.
        const composedAt = new Date().toISOString()
        const sourceSignals = inputsToSourceSignals(inputs)
        const { error: upsertErr } = await supabase
          .from('agent_profiles')
          .upsert(
            {
              company_id: companyId,
              horizontal_atoms: selection.horizontal_atoms,
              vertical_atoms: selection.vertical_atoms,
              modifier_atoms: selection.modifier_atoms,
              profile_summary: narrative,
              source_signals: sourceSignals,
              // Persist so the Phase C intake agent can read them server-
              // side when the chat opens. Plan §7 Phase C.
              verification_questions: selection.verification_questions,
              composed_at: composedAt,
              composer_model: OPUS_MODEL,
              composer_version: 1,
            },
            { onConflict: 'company_id' },
          )
        if (upsertErr) {
          send({ step: 'error', status: 'error', message: upsertErr.message })
          return
        }

        send({
          step: 'finalize',
          status: 'success',
          profile: {
            company_id: companyId,
            horizontal_atoms: selection.horizontal_atoms,
            vertical_atoms: selection.vertical_atoms,
            modifier_atoms: selection.modifier_atoms,
            is_multi_vertical: selection.is_multi_vertical,
            profile_summary: narrative,
            verification_questions: selection.verification_questions,
            uncertainty_notes: selection.uncertainty_notes,
            composer_model: OPUS_MODEL,
            composed_at: composedAt,
          },
        })

        // Step 5: fire-and-forget cache pre-warm. The client renders the
        // review card already; pre-warm just buys a faster first chat turn.
        send({ step: 'prewarm', status: 'in_progress' })
        const allIds = [
          ...selection.horizontal_atoms,
          ...selection.vertical_atoms,
          ...selection.modifier_atoms,
        ]
        if (allIds.length > 0) {
          const { data: rows } = await supabase
            .from('agent_atom_registry')
            .select('id, body')
            .in('id', allIds)
          const bodies = (rows ?? [])
            .map((r: { body: string | null }) => r.body ?? '')
            .filter((b: string) => b.length > 0)
          void preWarmAtomCache({ atomBodies: bodies })
        }
        send({ step: 'prewarm', status: 'success' })
      } catch (err) {
        send({
          step: 'error',
          status: 'error',
          message: err instanceof Error ? err.message : 'Composer pipeline failed',
        })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

// Run a promise against a wall-clock budget. The underlying work continues to
// completion on the server when the budget elapses: we just stop waiting for
// it. For Anthropic calls that's fine: a slow Opus turn finishing later still
// warms its own cache.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

