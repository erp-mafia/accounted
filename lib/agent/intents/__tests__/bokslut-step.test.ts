import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { bokslutStep } from '../bokslut-step'

// fiscal_periods has no `status` column: state is is_closed + locked_at
// (see lib/core/bookkeeping/period-service.ts and the period-lock triggers).
// Selecting `status` made PostgREST reject the whole query, so the bokslut
// intent never resolved a period and silently dropped the räkenskapsår from
// the prompt. The mocked Supabase harness happily returns whatever rows the
// test enqueues regardless of the column list, so these tests assert the
// SELECT string itself, plus the open/locked/closed/unknown prompt branches.

interface QueryResult {
  data: unknown
  error: unknown
}

interface RecordedSelect {
  table: string
  columns: string
}

function createRecordingSupabase(results: Record<string, QueryResult>) {
  const selects: RecordedSelect[] = []

  const buildChain = (table: string) => {
    const chain = {
      select: (columns: string) => {
        selects.push({ table, columns })
        return chain
      },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async (): Promise<QueryResult> =>
        results[table] ?? { data: null, error: null },
    }
    return chain
  }

  const supabase = {
    from: (table: string) => buildChain(table),
  } as unknown as SupabaseClient

  return { supabase, selects }
}

const COMPANY_ID = '22222222-2222-2222-2222-222222222222'
const PERIOD_ID = '33333333-3333-3333-3333-333333333333'

function periodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PERIOD_ID,
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    is_closed: false,
    locked_at: null,
    ...overrides,
  }
}

async function capture(results: Record<string, QueryResult>) {
  const { supabase, selects } = createRecordingSupabase(results)
  const captured = await bokslutStep.capture(
    { step_id: 'accruals', fiscal_year_end: null },
    { supabase, userId: 'user-1', companyId: COMPANY_ID },
  )
  return { captured, selects }
}

function render(captured: Awaited<ReturnType<typeof bokslutStep.capture>>) {
  return bokslutStep.promptTemplate({ captured, profileSummary: null, activeMemory: [] })
}

describe('bokslut.step capture', () => {
  it('selects the real fiscal_periods state columns, never a `status` column', async () => {
    const { selects } = await capture({
      fiscal_periods: { data: periodRow(), error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })

    const periodSelect = selects.find((s) => s.table === 'fiscal_periods')
    expect(periodSelect).toBeDefined()
    expect(periodSelect?.columns).toBe('id, period_start, period_end, is_closed, locked_at')
    // The column does not exist: requesting it makes PostgREST 400 the query.
    expect(periodSelect?.columns).not.toMatch(/\bstatus\b/)
  })

  it('maps an unlocked, unclosed period to status open', async () => {
    const { captured } = await capture({
      fiscal_periods: { data: periodRow(), error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })

    expect(captured.period_lookup_failed).toBe(false)
    expect(captured.fiscal_period).toMatchObject({
      id: PERIOD_ID,
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      status: 'open',
      lock_date: null,
    })
  })

  it('maps locked_at to status locked and is_closed to status closed', async () => {
    const { captured: locked } = await capture({
      fiscal_periods: { data: periodRow({ locked_at: '2026-02-01T10:00:00Z' }), error: null },
      companies: { data: null, error: null },
    })
    expect(locked.fiscal_period?.status).toBe('locked')
    expect(locked.fiscal_period?.lock_date).toBe('2026-02-01T10:00:00Z')

    // is_closed wins over locked_at, same precedence as period-service.
    const { captured: closed } = await capture({
      fiscal_periods: {
        data: periodRow({ is_closed: true, locked_at: '2026-02-01T10:00:00Z' }),
        error: null,
      },
      companies: { data: null, error: null },
    })
    expect(closed.fiscal_period?.status).toBe('closed')
  })

  it('fails closed when the period lookup errors', async () => {
    const { captured } = await capture({
      fiscal_periods: { data: null, error: { message: 'column does not exist' } },
      companies: { data: { entity_type: 'ab' }, error: null },
    })

    expect(captured.fiscal_period).toBeNull()
    expect(captured.period_lookup_failed).toBe(true)
  })
})

describe('bokslut.step prompt template', () => {
  it('states the period is open without any lock warning', async () => {
    const { captured } = await capture({
      fiscal_periods: { data: periodRow(), error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })
    const out = render(captured)

    expect(out).toContain('Räkenskapsår: 2025-01-01 → 2025-12-31 (status: öppen)')
    expect(out).not.toContain('VARNING')
    expect(out).not.toContain('Perioden är LÅST')
    expect(out).not.toContain('Perioden är STÄNGD')
  })

  it('tells the agent not to propose bookings in a closed period', async () => {
    const { captured } = await capture({
      fiscal_periods: { data: periodRow({ is_closed: true }), error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })
    const out = render(captured)

    expect(out).toContain('(status: stängd)')
    expect(out).toContain('Perioden är STÄNGD')
    expect(out).toContain('BFL 5 kap 5 §')
    expect(out).toContain('Föreslå inga bokningar')
  })

  it('tells the agent a locked period must be unlocked first', async () => {
    const { captured } = await capture({
      fiscal_periods: { data: periodRow({ locked_at: '2026-02-01T10:00:00Z' }), error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })
    const out = render(captured)

    expect(out).toContain('(status: låst)')
    expect(out).toContain('Perioden är LÅST')
    expect(out).toContain('2026-02-01T10:00:00Z')
  })

  it('never presents an unresolvable year as open', async () => {
    const { captured: errored } = await capture({
      fiscal_periods: { data: null, error: { message: 'boom' } },
      companies: { data: { entity_type: 'ab' }, error: null },
    })
    const erroredOut = render(errored)
    expect(erroredOut).toContain('uppslaget av räkenskapsåret misslyckades')
    expect(erroredOut).toContain('OKÄND')
    expect(erroredOut).toContain('Anta INTE att året är öppet')
    expect(erroredOut).not.toContain('status: öppen')

    const { captured: missing } = await capture({
      fiscal_periods: { data: null, error: null },
      companies: { data: { entity_type: 'ab' }, error: null },
    })
    const missingOut = render(missing)
    expect(missingOut).toContain('inget räkenskapsår hittades')
    expect(missingOut).toContain('Anta INTE att året är öppet')
    expect(missingOut).not.toContain('status: öppen')
  })

  it('exposes gnubok_list_fiscal_periods so the fail-closed instruction is actionable', () => {
    expect(bokslutStep.tools).toContain('gnubok_list_fiscal_periods')
    expect(bokslutStep.tools).toContain('gnubok_year_end_readiness')
    expect(bokslutStep.tools).toContain('gnubok_post_kontantmetod_cutoff')
  })
})
