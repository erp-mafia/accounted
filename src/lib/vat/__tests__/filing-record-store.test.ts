import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listVatFilings,
  markVatPeriodFiled,
  unmarkVatPeriodFiled,
} from '../filing-record-store'

/**
 * Sequential query results plus the payloads handed to insert()/update() and
 * the filters each query carried: the payload is where the persisted state
 * is observable, the filters are where the atomic guards are.
 */
function createStoreSupabase(results: { data?: unknown; error?: unknown }[]) {
  const captured: {
    table: string
    insert?: Record<string, unknown>
    update?: Record<string, unknown>
    filters: unknown[][]
  }[] = []
  let idx = 0
  const from = (table: string) => {
    const result = results[idx++] ?? { data: null, error: null }
    const entry: (typeof captured)[number] = { table, filters: [] }
    captured.push(entry)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'order', 'limit', 'maybeSingle', 'single']) {
      b[m] = () => b
    }
    for (const m of ['eq', 'in', 'is', 'or']) {
      b[m] = (...args: unknown[]) => {
        entry.filters.push([m, ...args])
        return b
      }
    }
    b.insert = (payload: Record<string, unknown>) => {
      entry.insert = payload
      return b
    }
    b.update = (payload: Record<string, unknown>) => {
      entry.update = payload
      return b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { supabase: { from } as unknown as SupabaseClient, captured }
}

const COMPANY = 'company-1'
const TODAY = '2026-09-17'

const pendingRow = {
  id: 'd-q2',
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2026-Q2',
  is_completed: false,
  completed_at: null,
  status: 'overdue',
  notes: 'Egen anteckning',
  due_date: '2026-08-17',
}

describe('listVatFilings', () => {
  it('maps completed moms deadlines to records, skipping yearly and incomplete rows', async () => {
    const { supabase } = createStoreSupabase([
      {
        data: [
          {
            id: 'd-q2',
            tax_deadline_type: 'moms_quarterly',
            tax_period: '2026-Q2',
            is_completed: true,
            // 22:30 UTC is 00:30 the next day in Stockholm (CEST).
            completed_at: '2026-08-11T22:30:00.000Z',
            status: 'confirmed',
            notes: null,
            due_date: '2026-08-17',
          },
          {
            id: 'd-m03',
            tax_deadline_type: 'moms_monthly',
            tax_period: '2026-03',
            is_completed: true,
            completed_at: '2026-05-10T12:00:00.000Z',
            status: 'submitted',
            notes: 'Skatteverkets referens: KV-9',
            due_date: '2026-05-12',
          },
          {
            id: 'd-fy',
            tax_deadline_type: 'moms_yearly',
            tax_period: '2025',
            is_completed: true,
            completed_at: '2026-07-01T12:00:00.000Z',
            status: 'confirmed',
            notes: null,
            due_date: '2026-06-26',
          },
          {
            id: 'd-broken',
            tax_deadline_type: 'moms_quarterly',
            tax_period: '2026-Q1',
            is_completed: true,
            completed_at: null,
            status: 'submitted',
            notes: null,
            due_date: '2026-05-12',
          },
        ],
      },
    ])
    const records = await listVatFilings(supabase, COMPANY)
    expect(records).toEqual([
      {
        deadline_id: 'd-q2',
        period_type: 'quarterly',
        year: 2026,
        period: 2,
        tax_period: '2026-Q2',
        filed_on: '2026-08-12',
        source: 'skatteverket',
        reference: null,
      },
      {
        deadline_id: 'd-m03',
        period_type: 'monthly',
        year: 2026,
        period: 3,
        tax_period: '2026-03',
        filed_on: '2026-05-10',
        source: 'manual',
        reference: 'KV-9',
      },
    ])
  })

  it('throws on a query error', async () => {
    const { supabase } = createStoreSupabase([{ error: { message: 'boom' } }])
    await expect(listVatFilings(supabase, COMPANY)).rejects.toEqual({ message: 'boom' })
  })
})

describe('markVatPeriodFiled', () => {
  it('refuses bad dates before touching the database', async () => {
    const { supabase, captured } = createStoreSupabase([])
    const base = { periodType: 'quarterly' as const, year: 2026, period: 2 }
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, period: 3, filedOn: TODAY }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, filedOn: '2026-06-30' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_DATE_BEFORE_PERIOD_END' })
    await expect(
      markVatPeriodFiled(supabase, COMPANY, { ...base, filedOn: '2026-09-18' }, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_DATE_IN_FUTURE' })
    expect(captured).toHaveLength(0)
  })

  it('completes the existing deadline row with the date and reference', async () => {
    const { supabase, captured } = createStoreSupabase([
      { data: pendingRow },
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: 'KV-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: true,
      record: { deadline_id: 'd-q2', filed_on: '2026-08-10', source: 'manual', reference: 'KV-1' },
    })
    expect(captured[1].table).toBe('deadlines')
    expect(captured[1].update).toMatchObject({
      is_completed: true,
      completed_at: '2026-08-10T12:00:00.000Z',
      status: 'submitted',
      notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
    })
    // The guard rides on the UPDATE itself, not only on the read before it.
    expect(captured[1].filters).toContainEqual([
      'or',
      'is_completed.eq.false,status.is.null,status.neq.confirmed',
    ])
  })

  it('yields to a Skatteverket confirmation that lands between the read and the write', async () => {
    const { supabase, captured } = createStoreSupabase([
      { data: pendingRow }, // read: still pending
      { data: null }, // guarded update matched zero rows: the cron got there first
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-11T09:00:00.000Z',
          status: 'confirmed',
        },
      }, // re-read: confirmed
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', reference: 'KV-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: false,
      record: { source: 'skatteverket', filed_on: '2026-08-11', reference: null },
    })
    expect(captured).toHaveLength(3)
  })

  it('raises a conflict when the row changed under it for any other reason', async () => {
    const { supabase } = createStoreSupabase([{ data: pendingRow }, { data: null }, { data: null }])
    await expect(
      markVatPeriodFiled(
        supabase,
        COMPANY,
        { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10' },
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('leaves a Skatteverket-confirmed period untouched', async () => {
    const confirmed = {
      ...pendingRow,
      is_completed: true,
      completed_at: '2026-08-11T09:00:00.000Z',
      status: 'confirmed',
    }
    const { supabase, captured } = createStoreSupabase([{ data: confirmed }])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10' },
      { today: TODAY },
    )
    expect(result).toMatchObject({
      ok: true,
      created: false,
      changed: false,
      record: { source: 'skatteverket', filed_on: '2026-08-11' },
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].update).toBeUndefined()
  })

  it('creates the deadline row the generator would have, already completed', async () => {
    const { supabase, captured } = createStoreSupabase([
      { data: null },
      { data: { vat_taxable_base_over_40m: false } },
      {
        data: {
          id: 'd-new',
          tax_deadline_type: 'moms_quarterly',
          tax_period: '2026-Q2',
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: null,
          due_date: '2026-08-17',
        },
      },
    ])
    const result = await markVatPeriodFiled(
      supabase,
      COMPANY,
      { periodType: 'quarterly', year: 2026, period: 2, filedOn: '2026-08-10', userId: 'user-1' },
      { today: TODAY },
    )
    expect(result).toMatchObject({ ok: true, created: true, changed: true })
    expect(captured[1].table).toBe('company_settings')
    expect(captured[2].table).toBe('deadlines')
    expect(captured[2].insert).toMatchObject({
      company_id: COMPANY,
      user_id: 'user-1',
      title: 'Momsdeklaration Q2 2026',
      due_date: '2026-08-17',
      deadline_type: 'tax',
      is_completed: true,
      completed_at: '2026-08-10T12:00:00.000Z',
      source: 'system',
      status: 'submitted',
      notes: null,
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q2',
      linked_report_type: 'vat',
      linked_report_period: { year: 2026, quarter: 2 },
      is_auto_generated: true,
    })
  })
})

describe('unmarkVatPeriodFiled', () => {
  const input = { periodType: 'quarterly' as const, year: 2026, period: 2 }

  it('answers not found when the period has no completed row', async () => {
    const none = createStoreSupabase([{ data: null }])
    await expect(unmarkVatPeriodFiled(none.supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_NOT_FOUND',
    })
    const pending = createStoreSupabase([{ data: pendingRow }])
    await expect(
      unmarkVatPeriodFiled(pending.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
  })

  it('refuses to erase a Skatteverket kvittens', async () => {
    const { supabase, captured } = createStoreSupabase([
      { data: { ...pendingRow, is_completed: true, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(unmarkVatPeriodFiled(supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })
    expect(captured).toHaveLength(1)
  })

  it('puts a manual mark back to pending and drops the reference line', async () => {
    const { supabase, captured } = createStoreSupabase([
      {
        data: {
          ...pendingRow,
          is_completed: true,
          completed_at: '2026-08-10T12:00:00.000Z',
          status: 'submitted',
          notes: 'Egen anteckning\nSkatteverkets referens: KV-1',
        },
      },
      { data: { id: 'd-q2' } },
    ])
    await expect(unmarkVatPeriodFiled(supabase, COMPANY, input, { today: TODAY })).resolves.toEqual({
      ok: true,
      deadline_id: 'd-q2',
    })
    expect(captured[1].update).toMatchObject({
      is_completed: false,
      completed_at: null,
      // due 2026-08-17 is behind today, so straight to overdue.
      status: 'overdue',
      notes: 'Egen anteckning',
    })
    // Only a row that is still a completed, unconfirmed filing is unmarked.
    expect(captured[1].filters).toContainEqual(['eq', 'is_completed', true])
    expect(captured[1].filters).toContainEqual(['or', 'status.is.null,status.neq.confirmed'])
  })

  const manualRow = {
    ...pendingRow,
    is_completed: true,
    completed_at: '2026-08-10T12:00:00.000Z',
    status: 'submitted',
  }

  it('never reports success when the guarded update matched nothing', async () => {
    // Confirmed in between: the refusal names the real reason.
    const confirmedNow = createStoreSupabase([
      { data: manualRow },
      { data: null },
      { data: { ...manualRow, completed_at: '2026-08-11T09:00:00.000Z', status: 'confirmed' } },
    ])
    await expect(
      unmarkVatPeriodFiled(confirmedNow.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET' })

    // Already un-ticked elsewhere (the deadlines page, another tab).
    const alreadyPending = createStoreSupabase([{ data: manualRow }, { data: null }, { data: pendingRow }])
    await expect(
      unmarkVatPeriodFiled(alreadyPending.supabase, COMPANY, input, { today: TODAY }),
    ).resolves.toEqual({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
  })
})
