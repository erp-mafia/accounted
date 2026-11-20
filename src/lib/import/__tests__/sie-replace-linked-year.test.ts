import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeFiscalPeriod, type TableMockResolver, type TableMockResult } from '@/tests/helpers'
import type { FiscalPeriod } from '@/types'
import { ensureFiscalPeriod, precheckFiscalPeriod } from '../sie-import'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * The SIE import replaces an empty, open year that overlaps the file's year
 * (precheckFiscalPeriod: create, replacesEmptyPeriodId). On 2026-11-15 one
 * company got three 500s in a row: the empty year had been created by hand in
 * front of the next year, which links the next year to it, and
 * fiscal_periods.previous_period_id has no ON DELETE action, so the delete
 * failed with fiscal_periods_previous_period_id_fkey.
 *
 * The table below keeps its rows and refuses that delete the way Postgres
 * does, so the test fails for the reason production did.
 */

const COMPANY = 'company-1'
const PREVIOUS_PERIOD_FK = {
  code: '23503',
  message:
    'update or delete on table "fiscal_periods" violates foreign key constraint ' +
    '"fiscal_periods_previous_period_id_fkey" on table "fiscal_periods"',
}

const year = (id: string, start: string, end: string, previous: string | null = null) =>
  makeFiscalPeriod({ id, company_id: COMPANY, name: id, period_start: start, period_end: end, previous_period_id: previous })

type Chain = Parameters<TableMockResolver>[0]

function matches(row: FiscalPeriod, chain: Chain): boolean {
  return chain.every(({ method, args }) => {
    const value = row[args[0] as keyof FiscalPeriod]
    const wanted = args[1]
    if (method === 'eq') return value === wanted
    if (method === 'neq') return value !== wanted
    if (method === 'lte') return String(value) <= String(wanted)
    if (method === 'gt') return String(value) > String(wanted)
    if (method === 'gte') return String(value) >= String(wanted)
    return true
  })
}

/**
 * fiscal_periods as rows: reads filter, order and limit them; update and
 * delete change them; a delete that would leave a row's previous_period_id
 * pointing at a removed year is refused with Postgres's own error. `refuse`
 * answers a write with an error instead (another constraint, a dropped call).
 */
function fiscalYears(rows: FiscalPeriod[], refuse: { delete?: TableMockResult['error']; insert?: TableMockResult['error'] } = {}) {
  return (chain: Chain): TableMockResult => {
    const hit = rows.filter((row) => matches(row, chain))
    const write = chain.find(({ method }) => ['insert', 'update', 'delete'].includes(method))
    if (write?.method === 'update') {
      for (const row of hit) Object.assign(row, write.args[0])
      return { data: null, error: null }
    }
    if (write?.method === 'delete') {
      if (refuse.delete) return { data: null, error: refuse.delete }
      const removed = new Set(hit.map((row) => row.id))
      const stillLinked = rows.some(
        (row) => !removed.has(row.id) && row.previous_period_id !== null && removed.has(row.previous_period_id),
      )
      if (stillLinked) return { data: null, error: PREVIOUS_PERIOD_FK }
      rows.splice(0, rows.length, ...rows.filter((row) => !removed.has(row.id)))
      return { data: null, error: null }
    }
    if (write?.method === 'insert') {
      if (refuse.insert) return { data: null, error: refuse.insert }
      const added = makeFiscalPeriod({ id: 'file-year', ...(write.args[0] as Partial<FiscalPeriod>) })
      rows.push(added)
      return { data: added, error: null }
    }
    let out = [...hit]
    for (const { method, args } of chain) {
      if (method === 'order') {
        const column = args[0] as keyof FiscalPeriod
        const direction = (args[1] as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1
        out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * direction)
      }
      if (method === 'limit') out = out.slice(0, Number(args[0]))
    }
    if (chain.some(({ method }) => method === 'single')) {
      return out.length === 1 ? { data: out[0] } : { data: null, error: { code: 'PGRST116', message: 'no single row' } }
    }
    if (chain.some(({ method }) => method === 'maybeSingle')) return { data: out[0] ?? null }
    return { data: out }
  }
}

function company(rows: FiscalPeriod[], refuse?: Parameters<typeof fiscalYears>[1]): SupabaseClient {
  const { supabase } = createTableMockSupabase({
    fiscal_periods: fiscalYears(rows, refuse),
    journal_entries: { data: [] },
    companies: { data: { entity_type: 'aktiebolag' } },
  })
  return supabase as unknown as SupabaseClient
}

/** What the route's error envelope answers when the import refuses. */
async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => {
      throw new Error('expected the import to refuse')
    },
    (caught: unknown) => caught,
  )
  const res = errorResponse(err, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, { requestId: 'req-1' })
  return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error }
}

describe('ensureFiscalPeriod replacing an empty year the next year is linked to', () => {
  // The empty 2024 was created by hand in front of 2025, which now points at it.
  const books = () => [
    year('fy-2024-empty', '2024-01-01', '2024-12-31'),
    year('fy-2025', '2025-01-01', '2025-12-31', 'fy-2024-empty'),
  ]

  it('replaces the year and links the next year to the file\'s year when they meet', async () => {
    const rows = books()
    const supabase = company(rows)

    // The parse preview promises this replacement; the import keeps the promise.
    await expect(precheckFiscalPeriod(supabase, COMPANY, '2023-07-01', '2024-12-31')).resolves.toEqual({
      verdict: 'create',
      replacesEmptyPeriodId: 'fy-2024-empty',
    })

    const id = await ensureFiscalPeriod(supabase, COMPANY, '2023-07-01', '2024-12-31')

    expect(id).toBe('file-year')
    expect(rows.map((row) => row.id)).toEqual(['fy-2025', 'file-year'])
    expect(rows.find((row) => row.id === 'fy-2025')?.previous_period_id).toBe('file-year')
  })

  it('leaves the next year unlinked when the file\'s year ends before it starts (a gap)', async () => {
    const rows = books()

    const id = await ensureFiscalPeriod(company(rows), COMPANY, '2023-07-01', '2024-06-30')

    expect(id).toBe('file-year')
    expect(rows.map((row) => row.id)).toEqual(['fy-2025', 'file-year'])
    expect(rows.find((row) => row.id === 'fy-2025')?.previous_period_id).toBeNull()
  })

  it('answers a year that still cannot be removed with what to do, as a 400, and creates nothing', async () => {
    const rows = books()
    const supabase = company(rows, {
      delete: {
        code: '23503',
        message:
          'update or delete on table "fiscal_periods" violates foreign key constraint ' +
          '"fiscal_period_tax_adjustments_fiscal_period_id_fkey" on table "fiscal_period_tax_adjustments"',
      },
    })

    const { status, error } = await refusal(ensureFiscalPeriod(supabase, COMPANY, '2023-07-01', '2024-12-31'))

    expect(status).toBe(400)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toBe(
      'Räkenskapsåret som överlappar SIE-filens räkenskapsår (2023-07-01 till 2024-12-31) är tomt men kan inte ersättas, ' +
        'eftersom andra uppgifter är kopplade till det. Ändra dess datum under Inställningar > Bokföring > Räkenskapsår ' +
        'till 2023-07-01 till 2024-12-31, så används det för importen, eller så att det inte längre överlappar. ' +
        'Importera sedan filen på nytt.',
    )
    expect(rows.map((row) => row.id)).toEqual(['fy-2024-empty', 'fy-2025'])
  })

  it('answers a file year that overlaps another year with a new import, as a 400', async () => {
    const supabase = company(books(), {
      insert: { code: '23P01', message: 'conflicting key value violates exclusion constraint "no_overlapping_fiscal_periods"' },
    })

    const { status, error } = await refusal(ensureFiscalPeriod(supabase, COMPANY, '2023-07-01', '2024-12-31'))

    expect(status).toBe(400)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toBe(
      'SIE-filens räkenskapsår (2023-07-01 till 2024-12-31) överlappar ett annat räkenskapsår i Accounted och kunde inte läggas upp. ' +
        'Importera filen på nytt, så prövas den mot räkenskapsåren som de ser ut nu.',
    )
  })

  // No sentence of ours fits a failure nobody can act on: the envelope answers
  // a transient one as retryable and keeps anything else a 500 that is seen.
  it('leaves a transient database failure to the envelope: retryable, not a 400', async () => {
    const supabase = company(books(), {
      delete: { code: '57014', message: 'canceling statement due to statement timeout' },
    })

    const { status, error } = await refusal(ensureFiscalPeriod(supabase, COMPANY, '2023-07-01', '2024-12-31'))

    expect(status).toBe(503)
    expect(error.code).toBe('TRANSIENT_ERROR')
  })
})
