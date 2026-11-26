/**
 * Two overlapping saves of an årsredovisning narrative (two tabs, or an agent
 * and a person) that answer different keys of the same keyed field both
 * survive, on real Postgres (#3768).
 *
 * A save of a keyed field (disclosure_answers, equity_movement_overrides,
 * fixed_asset_note_rows) merges the keys it sends into the stored ones, so it
 * reads the row first. Here both saves read the row before either writes:
 * written back as read, the later save's copy lacks the earlier save's keys
 * and one answer is lost without a word. A key one save removes must not come
 * back with the other save's copy either.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts).
 * The supabase-js query builder, RLS for the signed-in owner, the
 * arsredovisning_narratives_updated_at trigger, the unique key and the row
 * locks of two concurrent transactions are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { updateArsredovisningNarrative } from '@/lib/bokslut/arsredovisning/workflow-service'
import { NarrativeUpdateSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import type { OperationContext } from '@/lib/operations/types'
import { createPgRest, type PgRest } from './postgrest-over-pg'
import { seedCompany } from './fixtures'
import { getPool } from './setup'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

const shims: PgRest[] = []

/**
 * Holds every save's narrative write until each save has read the narrative
 * once, so all of them merge into the same stored row. A save that never
 * reads holds the others until the test times out.
 */
function readBeforeAnyWrite(saves: number) {
  let reads = 0
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return {
    read() {
      reads += 1
      if (reads === saves) open()
    },
    beforeWrite: () => opened,
  }
}

/** A signed-in session of its own (a browser tab), whose narrative writes wait for `gate`. */
function tab(userId: string, gate: ReturnType<typeof readBeforeAnyWrite>): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  shims.push(rest)
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const narrative = url.pathname === '/rest/v1/arsredovisning_narratives'
    const read = (init?.method ?? 'GET').toUpperCase() === 'GET'
    if (narrative && !read) await gate.beforeWrite()
    const response = await rest.fetch(input, init)
    if (narrative && read) gate.read()
    return response
  }
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

let userId: string
let companyId: string
let fiscalPeriodId: string

beforeEach(async () => {
  ;({ userId, companyId, fiscalPeriodId } = await seedCompany())
})

afterEach(() => {
  expect(shims.splice(0).flatMap((shim) => shim.unsupported)).toEqual([])
})

/**
 * Run the saves side by side, each body validated as the doors validate it:
 * every save reads the stored narrative before any of them writes.
 */
async function overlappingSaves(...bodies: Record<string, unknown>[]) {
  const gate = readBeforeAnyWrite(bodies.length)
  return Promise.all(
    bodies.map((body) => {
      const ctx: OperationContext = { supabase: tab(userId, gate), companyId, userId, log }
      return updateArsredovisningNarrative(ctx, fiscalPeriodId, NarrativeUpdateSchema.parse(body), { dryRun: false })
    }),
  )
}

async function stored() {
  const { rows } = await getPool().query<{ disclosure_answers: Record<string, unknown> }>(
    `SELECT disclosure_answers FROM public.arsredovisning_narratives WHERE company_id = $1 AND fiscal_period_id = $2`,
    [companyId, fiscalPeriodId],
  )
  return rows
}

describe('arsredovisning narrative: overlapping saves of different keys.pg', () => {
  it('keeps both saves\' answers, and the answer one of them removed stays removed', async () => {
    await getPool().query(
      `INSERT INTO public.arsredovisning_narratives (user_id, company_id, fiscal_period_id, disclosure_answers)
       VALUES ($1, $2, $3, $4)`,
      [userId, companyId, fiscalPeriodId, { 'fb.agare': { applies: false }, 'not.rattelse': { applies: false } }],
    )

    const outcomes = await overlappingSaves(
      { disclosure_answers: { 'not.rattelse': null, 'not.handelser_efter_balansdagen': { applies: false } } },
      { disclosure_answers: { 'fb.fortlevnad': { applies: false } } },
    )

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true])
    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.disclosure_answers).toEqual({
      'fb.agare': { applies: false },
      'not.handelser_efter_balansdagen': { applies: false },
      'fb.fortlevnad': { applies: false },
    })
  })

  it('keeps both saves\' answers when neither found a narrative to merge into', async () => {
    const outcomes = await overlappingSaves(
      { disclosure_answers: { 'fb.agare': { applies: false } } },
      { disclosure_answers: { 'fb.fortlevnad': { applies: false } } },
    )

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true])
    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.disclosure_answers).toEqual({
      'fb.agare': { applies: false },
      'fb.fortlevnad': { applies: false },
    })
  })
})
